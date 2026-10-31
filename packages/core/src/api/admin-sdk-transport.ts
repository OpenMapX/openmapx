import { readBoundedJsonResponse, readBoundedResponseText } from "../utils/fetchJson";
import { consumeAdminBytes } from "./admin-byte-reader";
import {
  type ApiClient,
  ApiClientError,
  ApiNativeDownloadUnavailableError,
  ApiRequestAbortedError,
  type ApiRequestOptions,
  apiClient,
  parseRetryAfter,
} from "./client";
import { accountAdminOperations } from "./contracts/account-admin";
import { activityAdminOperations } from "./contracts/activity-admin";
import { type AdminOperation, assertAdminOperationContract } from "./contracts/admin";
import { dataManagerAdminOperations } from "./contracts/data-manager-admin";
import { extensionAdminOperations } from "./contracts/extension-admin";
import { integrationAdminOperations } from "./contracts/integration-admin";
import { privacyAdminOperations } from "./contracts/privacy-admin";
import { serviceAdminOperations } from "./contracts/service-admin";
import { ApiContractError } from "./sdk-transport";

export type AdminSdkRequestOptions = Omit<RequestInit, "signal" | "credentials"> &
  ApiRequestOptions & {
    client?: ApiClient;
    maxJsonBytes?: number;
    maxTextBytes?: number;
    maxErrorBytes?: number;
    /** Called within ApiClient's abort/deadline lifetime; never receives a raw Response. */
    onTextChunk?: (chunk: string) => void | Promise<void>;
    onByteChunk?: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>;
    onByteHeaders?: (headers: Headers, signal: AbortSignal) => void | Promise<void>;
  };
export type AdminBinaryUploadRequestOptions = Omit<
  AdminSdkRequestOptions,
  "body" | "onTextChunk" | "keepalive"
>;
export type AdminByteResponseRequestOptions = Omit<
  AdminSdkRequestOptions,
  "body" | "onTextChunk" | "keepalive"
> & {
  onByteChunk: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>;
  onByteHeaders?: (headers: Headers, signal: AbortSignal) => void | Promise<void>;
};
export type { AdminNativeDownloadTarget } from "./client";
export type AdminNativeDownloadTargetOptions = {
  client?: ApiClient;
  signal?: AbortSignal;
  method?: "GET";
  headers?: Readonly<Record<string, never>>;
};
/** Required consumer for incremental plain text; successful envelope data is undefined. */
export type AdminTextStreamRequestOptions = AdminSdkRequestOptions & {
  onTextChunk: NonNullable<AdminSdkRequestOptions["onTextChunk"]>;
};
/** Constructs a connection target only; the caller owns the subsequent EventSource lifetime. */
export interface AdminEventStreamTargetOptions {
  client?: ApiClient;
  /** Checked before construction only. Aborting later cannot close a browser-owned EventSource. */
  signal?: AbortSignal;
  /** Generated GET bookkeeping; constructing a target never performs a request. */
  method?: "GET";
  /** Generated header containers must be empty. Native EventSource cannot transmit custom headers. */
  headers?: Readonly<Record<string, never>>;
}
export interface AdminEventStreamTarget {
  url: string;
  withCredentials: boolean;
}
interface AdminResponse {
  status: number;
  headers: Headers;
  data: unknown;
}
const operations = {
  ...accountAdminOperations,
  ...dataManagerAdminOperations,
  ...activityAdminOperations,
  ...integrationAdminOperations,
  ...serviceAdminOperations,
  ...extensionAdminOperations,
  ...privacyAdminOperations,
};
type OperationId = keyof typeof operations;
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new Error("Administration response limits must be positive finite numbers");
  return result;
}
function matchesBoundRequest(url: string, method: string, operation: AdminOperation): boolean {
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
function headerValues(headers: Headers): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, name) => {
    values[name.toLowerCase()] = value;
  });
  return values;
}
function validateRequestHeaders(operation: AdminOperation, headers: HeadersInit | undefined): void {
  if (
    operation.request?.headers &&
    !operation.request.headers.safeParse(headerValues(new Headers(headers))).success
  )
    throw new Error("Administration request headers violate the contract");
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
export function createAdminOperationBinder<const Operations extends Record<string, AdminOperation>>(
  registry: Operations,
) {
  return (operationId: keyof Operations) => {
    const operation: AdminOperation = registry[operationId];
    assertAdminOperationContract(operation);
    return async <T = AdminResponse>(
      url: string,
      options: AdminSdkRequestOptions = {},
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
        throw new Error("Administration request does not match its bound operation");
      const byteResponse = Object.values(operation.responses).some(
          (contract) => contract.kind === "bytes",
        ),
        byteRequest = operation.requestBody?.kind === "bytes",
        binary = byteRequest || byteResponse;
      if (byteResponse && (!onByteChunk || body !== undefined || onTextChunk || keepalive))
        throw new Error("Byte response requires an owned byte consumer");
      if (byteRequest && (!(body instanceof Blob) || onTextChunk || keepalive))
        throw new Error("Binary upload requires the original Blob body");
      const effectiveTimeout = binary ? (timeoutMs ?? 72 * 3600_000) : timeoutMs;
      if (
        binary &&
        (!Number.isFinite(effectiveTimeout) ||
          !effectiveTimeout ||
          effectiveTimeout < 0 ||
          effectiveTimeout > 7 * 24 * 3600_000)
      )
        throw new Error("Invalid byte transfer deadline");
      // SSE is deliberately browser-owned and cannot enter the finite/JSON reader.
      if (
        Object.values(operation.responses).some(
          (c) => c.kind === "stream" && c.mediaType === "text/event-stream",
        )
      )
        throw new Error("Use the administration stream connection target");
      // Orval emits application/json even when an optional body is omitted.
      // An empty JSON entity is invalid to Fastify; absence must stay absence.
      const requestHeaders = new Headers(headers);
      if (byteRequest) requestHeaders.set("content-type", "application/octet-stream");
      if (body === undefined && operation.request?.body?.isOptional())
        requestHeaders.delete("content-type");
      validateRequestHeaders(operation, requestHeaders);
      const jsonBudget = binary
        ? Math.min(positive(maxJsonBytes, 64 * 1024), 64 * 1024)
        : positive(maxJsonBytes, 8 * 1024 * 1024);
      const textBudget = positive(maxTextBytes, 8 * 1024 * 1024);
      const errorBudget = binary
        ? Math.min(positive(maxErrorBytes, 64 * 1024), 64 * 1024)
        : positive(maxErrorBytes, 64 * 1024);
      const result = await client.request(
        url,
        { method, body, integrity, keepalive, mode, referrer, referrerPolicy },
        async (response, effectiveSignal): Promise<AdminResponse> => {
          const contract = operation.responses[response.status];
          if (!contract) {
            if (binary && response.body && !response.body.locked)
              await response.body.cancel().catch(() => {});
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
            if (binary && response.body && !response.body.locked)
              await response.body.cancel().catch(() => {});
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
/** Canonical operation identity and every status validator live in the closure. */
export const bindAdminOperation = createAdminOperationBinder(operations);
export function bindAdminStreamOperation(operationId: OperationId) {
  const operation: AdminOperation = operations[operationId];
  if (
    !Object.values(operation.responses).some(
      (c) => c.kind === "stream" && c.mediaType === "text/event-stream",
    )
  )
    throw new Error("Operation is not an EventSource stream");
  return async <T = AdminEventStreamTarget>(
    url: string,
    options: AdminEventStreamTargetOptions = {},
  ): Promise<T> => {
    const supported = new Set(["client", "signal", "method", "headers"]);
    if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !supported.has(key)))
      throw new Error("Unsupported EventSource target options");
    if (!matchesBoundRequest(url, options.method ?? "GET", operation))
      throw new Error("Administration request does not match its bound operation");
    const query = Object.fromEntries(new URL(url, "https://api.invalid").searchParams);
    if (operation.request?.query && !operation.request.query.safeParse(query).success)
      throw new Error("Administration stream query violates the contract");
    const headers = options.headers;
    const hasHeaders =
      headers instanceof Headers
        ? !headers.keys().next().done
        : Array.isArray(headers)
          ? headers.length > 0
          : headers && typeof headers === "object"
            ? Reflect.ownKeys(headers).length > 0
            : headers !== undefined;
    if (hasHeaders) throw new Error("EventSource cannot honor request headers");
    options.signal?.throwIfAborted();
    return (options.client ?? apiClient).connectionTarget(url) as T;
  };
}

type Success<T> = T extends { status: infer S extends number }
  ? `${S}` extends `2${string}`
    ? T
    : never
  : never;
export function unwrapAdminResponse<T extends { status: number; headers: Headers; data: unknown }>(
  response: T,
): Success<T> extends { data: infer D } ? D : never {
  if (response.status < 200 || response.status >= 300)
    throw new ApiClientError(
      response.status,
      response.data,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  return response.data as Success<T> extends { data: infer D } ? D : never;
}
/** Opt-in feature display; generic errors/logging retain their redacted message. */
export function adminErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError) || !error.payload || typeof error.payload !== "object")
    return fallback;
  const payload = error.payload as Record<string, unknown>;
  for (const key of ["errorMessage", "error", "message", "reason"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 512);
  }
  return fallback;
}

type ByteOperationId = {
  [K in OperationId]: Extract<
    (typeof operations)[K]["responses"][keyof (typeof operations)[K]["responses"]],
    { kind: "bytes" }
  > extends never
    ? never
    : K;
}[OperationId];
type BinaryUploadOperationId = {
  [K in OperationId]: (typeof operations)[K] extends { requestBody: { kind: "bytes" } } ? K : never;
}[OperationId];
export function bindAdminByteOperation(operationId: ByteOperationId) {
  return bindAdminOperation(operationId);
}
export function bindAdminBinaryUploadOperation(operationId: BinaryUploadOperationId) {
  return bindAdminOperation(operationId);
}
export function bindAdminDownloadTarget(operationId: ByteOperationId) {
  const operation: AdminOperation = operations[operationId];
  if (
    operation.method !== "GET" ||
    !Object.values(operation.responses).some((c) => c.kind === "bytes" && c.nativeDownload)
  )
    throw Error("Operation cannot construct a native download");
  return async (url: string, options: AdminNativeDownloadTargetOptions = {}) => {
    const supported = new Set(["client", "signal", "method", "headers"]);
    if (Reflect.ownKeys(options).some((k) => typeof k !== "string" || !supported.has(k)))
      throw new ApiNativeDownloadUnavailableError("headers");
    if (!matchesBoundRequest(url, options.method ?? "GET", operation))
      throw new ApiNativeDownloadUnavailableError("origin");
    const parsedUrl = new URL(url, "https://api.invalid"),
      template = operation.path.split("/"),
      segments = parsedUrl.pathname.split("/");
    const params = Object.fromEntries(
      template.flatMap((part, index) =>
        part.startsWith(":") ? [[part.slice(1), decodeURIComponent(segments[index])]] : [],
      ),
    );
    if (operation.request?.params && !operation.request.params.safeParse(params).success)
      throw new ApiNativeDownloadUnavailableError("origin");
    if (!operation.request?.query && parsedUrl.search)
      throw new ApiNativeDownloadUnavailableError("origin");
    if (options.headers && Reflect.ownKeys(options.headers).length)
      throw new ApiNativeDownloadUnavailableError("headers");
    if (
      operation.request?.query &&
      !operation.request.query.safeParse(
        Object.fromEntries(new URL(url, "https://api.invalid").searchParams),
      ).success
    )
      throw new ApiNativeDownloadUnavailableError("origin");
    options.signal?.throwIfAborted();
    return (options.client ?? apiClient).downloadTarget(url);
  };
}
