import { readBoundedJsonResponse, readBoundedResponseText } from "../http/fetchJson";
import { consumeAdminBytes } from "./admin-byte-reader";
import {
  type ApiClient,
  ApiClientError,
  ApiRequestAbortedError,
  type ApiRequestOptions,
  apiClient,
  parseRetryAfter,
} from "./client";
import { apiErrorSchema } from "./contracts/error";
import {
  type ApiOperation,
  assertOperationContract,
  downloadMediaTypes,
} from "./contracts/operation";
import { ApiContractError } from "./sdk-transport";

export type OperationRequestOptions = Omit<RequestInit, "signal" | "credentials"> &
  ApiRequestOptions & {
    client?: ApiClient;
    maxJsonBytes?: number;
    maxTextBytes?: number;
    maxErrorBytes?: number;
    /** UTF-8 saved-document downloads, consumed before acquisition releases its lifetime. */
    maxDownloadBytes?: number;
    /** Called within ApiClient's abort/deadline lifetime; never receives a raw Response. */
    onTextChunk?: (chunk: string) => void | Promise<void>;
    onByteChunk?: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>;
    onByteHeaders?: (headers: Headers, signal: AbortSignal) => void | Promise<void>;
  };
interface OperationResponse {
  status: number;
  headers: Headers;
  data: unknown;
}
const KIB = 1024;
const MIB = 1024 * KIB;
/** Byte transfers default to three days and may never ask for more than a week. */
const DEFAULT_BYTE_DEADLINE_MS = 72 * 3600_000;
const MAX_BYTE_DEADLINE_MS = 7 * 24 * 3600_000;
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new Error("API response limits must be positive finite numbers");
  return result;
}
export function matchesBoundRequest(url: string, method: string, operation: ApiOperation): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || method.toUpperCase() !== operation.method)
    return false;
  const path = new URL(url, "https://api.invalid");
  if (path.origin !== "https://api.invalid" || path.hash) return false;
  const expected = operation.path.split("/");
  const actual = path.pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index],
    )
  );
}
export function isEventStreamOperation(operation: ApiOperation): boolean {
  return Object.values(operation.responses).some(
    (contract) => contract.kind === "stream" && contract.mediaType === "text/event-stream",
  );
}
function headerValues(headers: Headers): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, name) => {
    values[name.toLowerCase()] = value;
  });
  return values;
}
function validateRequestHeaders(operation: ApiOperation, headers: HeadersInit | undefined): void {
  if (
    operation.request?.headers &&
    !operation.request.headers.safeParse(headerValues(new Headers(headers))).success
  )
    throw new Error("API request headers violate the contract");
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller can abort while constructing a rejecting callback promise.
    // Retain that promise even when cancellation already won.
    void pending.catch(() => {});
    signal.throwIfAborted();
  }
  let abort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function consumeTextStream(
  response: Response,
  signal: AbortSignal,
  consume: (chunk: string) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new ApiContractError(response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        completed = true;
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) await abortable(Promise.resolve(consume(chunk)), signal);
    }
    const final = decoder.decode();
    if (final) await abortable(Promise.resolve(consume(final)), signal);
    signal.throwIfAborted();
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Family descriptors are bound once by trusted SDK generation, never supplied by request callers. */
export function createOperationBinder<const Operations extends Record<string, ApiOperation>>(
  registry: Operations,
) {
  return (operationId: keyof Operations) => {
    const operation: ApiOperation | undefined = registry[operationId];
    if (!operation) throw new Error(`Unknown API operation ${String(operationId)}`);
    assertOperationContract(operation);
    return async <T = OperationResponse>(
      url: string,
      options: OperationRequestOptions = {},
    ): Promise<T> => {
      const {
        client = apiClient,
        signal,
        timeoutMs,
        cache,
        headers,
        maxJsonBytes,
        maxTextBytes,
        maxErrorBytes,
        maxDownloadBytes,
        onTextChunk,
        onByteChunk,
        onByteHeaders,
        method = "GET",
        body,
        integrity,
        keepalive,
        mode,
        referrer,
        referrerPolicy,
      } = options;
      if (!matchesBoundRequest(url, method, operation))
        throw new Error("API request does not match its bound operation");
      const byteResponse = Object.values(operation.responses).some(
          (contract) => contract.kind === "bytes",
        ),
        byteRequest = operation.requestBody?.kind === "bytes",
        binary = byteRequest || byteResponse;
      if (byteResponse && (!onByteChunk || body !== undefined || onTextChunk || keepalive))
        throw new Error("Byte response requires an owned byte consumer");
      if (byteRequest && (!(body instanceof Blob) || onTextChunk || keepalive))
        throw new Error("Binary upload requires the original Blob body");
      const effectiveTimeout = binary ? (timeoutMs ?? DEFAULT_BYTE_DEADLINE_MS) : timeoutMs;
      if (
        binary &&
        (!Number.isFinite(effectiveTimeout) ||
          !effectiveTimeout ||
          effectiveTimeout < 0 ||
          effectiveTimeout > MAX_BYTE_DEADLINE_MS)
      )
        throw new Error("Invalid byte transfer deadline");
      // SSE is deliberately browser-owned and cannot enter the finite/JSON reader.
      if (isEventStreamOperation(operation))
        throw new Error("Use the EventSource stream connection target");
      // Orval emits application/json even when an optional body is omitted.
      // An empty JSON entity is invalid to Fastify; absence must stay absence.
      const requestHeaders = new Headers(headers);
      if (byteRequest) requestHeaders.set("content-type", "application/octet-stream");
      if (body === undefined && operation.request?.body?.isOptional())
        requestHeaders.delete("content-type");
      validateRequestHeaders(operation, requestHeaders);
      // A byte transfer's JSON envelope is metadata, so its budget stays small.
      const jsonBudget = binary
        ? Math.min(positive(maxJsonBytes, 64 * KIB), 64 * KIB)
        : positive(maxJsonBytes, 8 * MIB);
      const textBudget = positive(maxTextBytes, 8 * MIB);
      const errorBudget = binary
        ? Math.min(positive(maxErrorBytes, 64 * KIB), 64 * KIB)
        : positive(maxErrorBytes, 64 * KIB);
      const downloadBudget = positive(maxDownloadBytes, 40 * MIB);
      // A byte stream that is not consumed is cancelled before the call
      // settles, so the caller never outlives its upstream connection.
      const releaseBinary = async (response: Response) => {
        if (binary && response.body && !response.body.locked)
          await response.body.cancel().catch(() => {});
      };
      const result = await client.request(
        url,
        { method, body, integrity, keepalive, mode, referrer, referrerPolicy },
        async (response, effectiveSignal): Promise<OperationResponse> => {
          const contract = operation.responses[response.status];
          if (!contract) {
            await releaseBinary(response);
            throw new ApiContractError(response.status);
          }
          try {
            if (
              contract.headers &&
              !contract.headers.safeParse(headerValues(response.headers)).success
            )
              throw new ApiContractError(response.status);
            const mediaType = response.headers
              .get("content-type")
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            let data: unknown;
            if (contract.kind === "empty") {
              const text = response.body
                ? await readBoundedResponseText(response, 1, { signal: effectiveSignal })
                : "";
              if (text !== "") throw new ApiContractError(response.status);
              data = undefined;
            } else if (contract.kind === "text-download") {
              if (
                !mediaType ||
                !downloadMediaTypes(
                  contract,
                  Object.fromEntries(new URL(url, "https://api.invalid").searchParams),
                ).includes(mediaType)
              )
                throw new ApiContractError(response.status);
              const text = await readBoundedResponseText(response, downloadBudget, {
                signal: effectiveSignal,
              });
              data = new Blob([text], { type: response.headers.get("content-type") ?? mediaType });
            } else {
              const correctMedia =
                contract.kind === "json"
                  ? mediaType === "application/json" || mediaType?.endsWith("+json")
                  : mediaType === contract.mediaType;
              if (!correctMedia) throw new ApiContractError(response.status);
              if (contract.kind === "bytes") {
                if (!onByteChunk) throw new ApiContractError(response.status);
                await consumeAdminBytes(response, effectiveSignal, { onByteChunk, onByteHeaders });
                data = undefined;
              } else if (contract.kind === "stream") {
                if (!onTextChunk) throw new ApiContractError(response.status);
                await consumeTextStream(response, effectiveSignal, onTextChunk);
                data = undefined;
              } else {
                const raw =
                  contract.kind === "json"
                    ? await readBoundedJsonResponse(response, {
                        maxBytes: response.ok ? jsonBudget : errorBudget,
                        signal: effectiveSignal,
                      })
                    : await readBoundedResponseText(
                        response,
                        response.ok ? textBudget : errorBudget,
                        { signal: effectiveSignal },
                      );
                const parsed = contract.schema.safeParse(raw);
                if (!parsed.success) throw new ApiContractError(response.status);
                data = parsed.data;
              }
            }
            return { status: response.status, headers: response.headers, data };
          } catch (error) {
            await releaseBinary(response);
            if (effectiveSignal.aborted || error instanceof ApiRequestAbortedError) throw error;
            throw new ApiContractError(response.status);
          }
        },
        {
          signal,
          timeoutMs: effectiveTimeout,
          cache,
          headers: requestHeaders,
          acceptedStatuses: "all",
          ...(byteRequest ? { expectedRequestMediaType: "application/octet-stream" as const } : {}),
        },
      );
      return result as T;
    };
  };
}
type Success<T> = T extends { status: infer S extends number }
  ? `${S}` extends `2${string}`
    ? T
    : never
  : never;
export function unwrapOperationResponse<
  T extends { status: number; headers: Headers; data: unknown },
>(response: T): Success<T> extends { data: infer D } ? D : never {
  if (response.status < 200 || response.status >= 300)
    throw new ApiClientError(
      response.status,
      response.data,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  return response.data as Success<T> extends { data: infer D } ? D : never;
}
/** Opt-in feature display; generic errors/logging retain their redacted message. */
export function operationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  const envelope = apiErrorSchema.safeParse(error.payload);
  return envelope.success && envelope.data.error.trim()
    ? envelope.data.error.slice(0, 512)
    : fallback;
}
