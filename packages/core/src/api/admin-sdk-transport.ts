import { readBoundedJsonResponse, readBoundedResponseText } from "../utils/fetchJson";
import {
  type ApiClient,
  ApiClientError,
  type ApiRequestOptions,
  apiClient,
  parseRetryAfter,
} from "./client";
import { activityAdminOperations } from "./contracts/activity-admin";
import type { AdminOperation } from "./contracts/admin";
import { dataManagerAdminOperations } from "./contracts/data-manager-admin";
import { integrationAdminOperations } from "./contracts/integration-admin";
import { ApiContractError } from "./sdk-transport";

export type AdminSdkRequestOptions = Omit<RequestInit, "signal" | "credentials"> &
  ApiRequestOptions & {
    client?: ApiClient;
    maxJsonBytes?: number;
    maxTextBytes?: number;
    maxErrorBytes?: number;
    /** Called within ApiClient's abort/deadline lifetime; never receives a raw Response. */
    onTextChunk?: (chunk: string) => void | Promise<void>;
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
  ...dataManagerAdminOperations,
  ...activityAdminOperations,
  ...integrationAdminOperations,
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
      if (body === undefined && operation.request?.body?.isOptional())
        requestHeaders.delete("content-type");
      validateRequestHeaders(operation, requestHeaders);
      const jsonBudget = positive(maxJsonBytes, 8 * 1024 * 1024);
      const textBudget = positive(maxTextBytes, 8 * 1024 * 1024);
      const errorBudget = positive(maxErrorBytes, 64 * 1024);
      const result = await client.request(
        url,
        { method, body, integrity, keepalive, mode, referrer, referrerPolicy },
        async (response, effectiveSignal): Promise<AdminResponse> => {
          const contract = operation.responses[response.status];
          if (!contract) throw new ApiContractError(response.status);
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
              if (contract.kind === "stream") {
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
            if (effectiveSignal.aborted) throw error;
            throw new ApiContractError(response.status);
          }
        },
        { signal, timeoutMs, cache, headers: requestHeaders, acceptedStatuses: "all" },
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
