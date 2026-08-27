import { USER_AGENT } from "./userAgent";

/** Default HTTP timeout for upstream JSON APIs. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Ordinary API JSON ceiling. Bulk feeds must opt into a reviewed larger bound. */
export const DEFAULT_FETCH_JSON_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FETCH_ERROR_MAX_BYTES = 1_024;
const BOUNDED_RESPONSE_CLEANUP_ATTEMPT_MS = 250;
const BOUNDED_RESPONSE_CLEANUP_TOTAL_MS = 1_500;

let warnedRaisedCeiling = false;

async function boundedResponseCleanupAttempt(
  operation: () => Promise<void>,
  deadlineAt: number,
): Promise<void> {
  const pending = Promise.resolve().then(operation);
  const remainingMs = Math.min(
    BOUNDED_RESPONSE_CLEANUP_ATTEMPT_MS,
    Math.max(0, deadlineAt - Date.now()),
  );
  if (remainingMs === 0) {
    void pending.catch(() => {});
    throw new Error("bounded response cleanup deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("bounded response cleanup attempt timed out")),
          remainingMs,
        );
        if (typeof timer === "object") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown | undefined> {
  try {
    await boundedResponseCleanupAttempt(
      () => reader.cancel(),
      Date.now() + BOUNDED_RESPONSE_CLEANUP_TOTAL_MS,
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

async function cancelBody(body: ReadableStream<Uint8Array>): Promise<unknown | undefined> {
  try {
    await boundedResponseCleanupAttempt(
      () => body.cancel(),
      Date.now() + BOUNDED_RESPONSE_CLEANUP_TOTAL_MS,
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

function withCleanupCause(primary: Error, cleanupError: unknown | undefined): Error {
  if (cleanupError !== undefined) {
    Object.defineProperty(primary, "cause", { configurable: true, value: cleanupError });
  }
  return primary;
}

async function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("response read aborted"));
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener?.();
  }
}

function retainLateResponseOwnership(operation: Promise<Response>): void {
  void operation
    .then(
      async (response) => {
        if (response.body) await cancelBody(response.body);
      },
      () => undefined,
    )
    .catch(() => {});
}

async function awaitResponseWithSignal(
  operation: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  const responseOperation = Promise.resolve(operation);
  const fetched = responseOperation.then(
    (response) => ({ response, type: "response" }) as const,
    (error) => ({ error, type: "failed" }) as const,
  );
  if (signal.aborted) {
    retainLateResponseOwnership(responseOperation);
    signal.throwIfAborted();
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<{ reason: unknown; type: "aborted" }>((resolve) => {
    const abort = (): void => resolve({ reason: signal.reason, type: "aborted" });
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  try {
    const outcome = await Promise.race([fetched, aborted]);
    if (outcome.type === "aborted") {
      retainLateResponseOwnership(responseOperation);
      throw outcome.reason ?? new Error("request aborted");
    }
    if (outcome.type === "failed") throw outcome.error;
    if (signal.aborted) {
      const cleanupError = outcome.response.body
        ? await cancelBody(outcome.response.body)
        : undefined;
      const primary = signal.reason instanceof Error ? signal.reason : new Error("request aborted");
      throw withCleanupCause(primary, cleanupError);
    }
    return outcome.response;
  } finally {
    removeAbortListener?.();
  }
}

/**
 * Deployment-wide ceiling for callers that do not pass `maxBytes`. The
 * operator may lower or raise it; raising is a deliberate capacity decision
 * (a large regional feed without an in-code opt-in), so it is honoured but
 * announced once rather than silently clamped.
 */
function configuredMaxBytes(): number {
  const raw = globalThis.process?.env?.OPENMAPX_FETCH_JSON_MAX_BYTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FETCH_JSON_MAX_BYTES;
  if (parsed > DEFAULT_FETCH_JSON_MAX_BYTES && !warnedRaisedCeiling) {
    warnedRaisedCeiling = true;
    console.warn(
      `[fetchJson] OPENMAPX_FETCH_JSON_MAX_BYTES=${raw} raises the default JSON response ceiling above ${DEFAULT_FETCH_JSON_MAX_BYTES} bytes for every caller without an explicit maxBytes`,
    );
  }
  return Math.floor(parsed);
}

export function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    mediaType === "text/json" ||
    // Raw-file hosts (raw.githubusercontent.com, many open-data portals)
    // serve JSON documents as text/plain. The body is still parsed strictly;
    // this only keeps HTML error pages and binary bodies out.
    mediaType === "text/plain" ||
    mediaType?.endsWith("+json") === true
  );
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  options: { truncate?: boolean; label?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const label = options.label ?? "response";
  const contentLength = response.headers?.get?.("content-length") ?? null;
  const declared = contentLength === null ? Number.NaN : Number(contentLength);
  if (!options.truncate && Number.isFinite(declared) && declared > maxBytes) {
    const cleanupError = response.body ? await cancelBody(response.body) : undefined;
    throw withCleanupCause(
      new Error(`${label} too large (declared ${declared} > ${maxBytes} bytes)`),
      cleanupError,
    );
  }
  if (!response.body) {
    if (response.status === 204 || declared === 0) return "";
    throw new Error(`${label} body is not stream-readable`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let cancellationAttempted = false;
  try {
    for (;;) {
      const { done, value } = await awaitWithSignal(reader.read(), options.signal);
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        cancellationAttempted = true;
        const cleanupError = await cancelReader(reader);
        if (options.truncate) {
          if (cleanupError !== undefined) {
            throw new Error(`${label} cleanup failed`, { cause: cleanupError });
          }
          return text + decoder.decode();
        }
        throw withCleanupCause(
          new Error(`${label} too large (exceeded ${maxBytes} bytes)`),
          cleanupError,
        );
      }
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!cancellationAttempted) {
      const cleanupError = await cancelReader(reader);
      if (error instanceof Error) throw withCleanupCause(error, cleanupError);
      if (cleanupError !== undefined) {
        throw new AggregateError([error, cleanupError], `${label} read and cleanup failed`);
      }
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return text + decoder.decode();
}

export async function readBoundedJsonResponse<T>(
  response: Response,
  options: { maxBytes?: number; label?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const label = options.label ?? "JSON response";
  const maxBytes = options.maxBytes ?? configuredMaxBytes();
  if (!isJsonMediaType(response.headers?.get?.("content-type") ?? null)) {
    const cleanupError = response.body ? await cancelBody(response.body) : undefined;
    throw withCleanupCause(new Error(`${label} has unexpected content type`), cleanupError);
  }
  const text = await readBoundedResponseText(response, maxBytes, {
    label,
    signal: options.signal,
  });
  return JSON.parse(text) as T;
}

export interface FetchJsonOptions {
  /** Caller cancellation, combined with this helper's own timeout. */
  signal?: AbortSignal;
  /** Abort the request after this many milliseconds. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Ceiling for the buffered response body in bytes. Defaults to
   * {@link DEFAULT_FETCH_JSON_MAX_BYTES}; deployments may lower or raise the
   * default with `OPENMAPX_FETCH_JSON_MAX_BYTES` (raising is logged once).
   * The request fails loudly on breach — a
   * truncated JSON document would parse into silently wrong data.
   */
  maxBytes?: number;
  /** Extra request headers, merged on top of the `User-Agent`. */
  headers?: Record<string, string>;
  /** Upstream name baked into thrown error messages, e.g. `"Open-Meteo HTTP 503"`. */
  label?: string;
  /**
   * Build the message thrown on a non-2xx response. Overrides `label`. Lets a
   * caller preserve a bespoke diagnostic string (status text, URL, path, …).
   * `body` is truncated to keep upstream diagnostics useful without allowing a
   * large or unexpected response to flood logs.
   */
  errorMessage?: (info: {
    status: number;
    statusText: string;
    url: string;
    body?: string;
  }) => string;
  /**
   * `User-Agent` to send. Defaults to the shared {@link USER_AGENT}. Pass `null`
   * to omit the header entirely (preserves the behaviour of callers that never
   * set one).
   */
  userAgent?: string | null;
  /** When `true`, return `null` on any failure (timeout, network, non-2xx, parse) instead of throwing. */
  nullOnError?: boolean;
  /** Extra `fetch` init (e.g. `method`, `body`). `signal` and `headers` are managed here. */
  init?: Omit<RequestInit, "signal" | "headers">;
}

async function request<T>(url: string, options: FetchJsonOptions): Promise<T> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    headers,
    label = "fetch",
    userAgent = USER_AGENT,
    errorMessage,
    init,
  } = options;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(
    () => timeoutController.abort(new Error(`${label} request timeout`)),
    timeoutMs,
  );
  if (typeof timeoutTimer === "object") timeoutTimer.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    signal.throwIfAborted();
    const fetchPromise = fetch(url, {
      ...init,
      signal,
      headers: { ...(userAgent ? { "User-Agent": userAgent } : {}), ...headers },
    });
    const res = await awaitResponseWithSignal(fetchPromise, signal);
    if (!res.ok) {
      const body = res.body
        ? (
            await readBoundedResponseText(res, DEFAULT_FETCH_ERROR_MAX_BYTES, {
              truncate: true,
              label: `${label} error response`,
              signal,
            })
          ).trim()
        : undefined;
      throw new Error(
        errorMessage
          ? errorMessage({ status: res.status, statusText: res.statusText, url, body })
          : `${label} HTTP ${res.status}`,
      );
    }
    return await readBoundedJsonResponse<T>(res, {
      maxBytes: options.maxBytes ?? configuredMaxBytes(),
      label: `${label} response`,
      signal,
    });
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * Fetch JSON with a `User-Agent` header and an `AbortController`-based timeout.
 *
 * Throws on a non-2xx response (with `label` in the message) or on timeout /
 * network / parse errors — unless `nullOnError` is set, in which case it
 * resolves to `null` on any failure.
 */
export function fetchJson<T>(
  url: string,
  options: FetchJsonOptions & { nullOnError: true },
): Promise<T | null>;
export function fetchJson<T>(url: string, options?: FetchJsonOptions): Promise<T>;
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  if (options.nullOnError) {
    try {
      return await request<T>(url, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return null;
    }
  }
  return request<T>(url, options);
}
