import type { ProviderHealthFailureOutcome } from "./context";

export interface ProviderCallContext {
  /** Request-scoped signal. Providers must pass it to cancellable I/O. */
  signal: AbortSignal;
  /** Absolute wall-clock deadline, for clients that accept a deadline rather than a signal. */
  deadlineAt: number;
}

export interface ProviderDeadlineOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("provider deadline exceeded");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderCancelledError extends Error {
  constructor() {
    super("provider call cancelled");
    this.name = "ProviderCancelledError";
  }
}

/** A provider answered, but the fields it consumes were missing or malformed. */
export class ProviderPayloadError extends Error {
  readonly code = "invalid_payload";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderPayloadError";
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof ProviderTimeoutError
    ? signal.reason
    : new ProviderCancelledError();
}

function isDeadline(value: unknown): boolean {
  return (
    value instanceof ProviderTimeoutError ||
    (value instanceof Error && value.name === "TimeoutError")
  );
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && chain.length < 8) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function numericField(error: unknown, field: "status" | "statusCode"): number | null {
  if (!error || typeof error !== "object" || !(field in error)) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function stringField(error: unknown, field: "code" | "name"): string | null {
  if (!error || typeof error !== "object" || !(field in error)) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

const CODE_OUTCOMES: Readonly<Record<string, ProviderHealthFailureOutcome>> = {
  quota_exhausted: "quota",
  invalid_response: "invalid_payload",
  invalid_payload: "invalid_payload",
  invalid_request: "input",
  unauthorized: "auth",
  forbidden: "auth",
  upstream_failure: "connection",
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
};

/**
 * Map a failed provider call to the health outcome it should record.
 *
 * The error that settled the call decides. A caller abort becomes
 * `caller_cancelled`, which provider health never counts, only when the error
 * itself is that abort (directly, by name or through its cause chain) while the
 * caller's signal is aborted. An upstream failure that settled first keeps its
 * own outcome even if the caller aborts before it is classified. Deadlines are
 * timeouts, whoever set them, and an abort the caller did not request is the
 * provider's own deadline.
 */
export function classifyProviderFailure(
  error: unknown,
  signal?: AbortSignal,
): ProviderHealthFailureOutcome {
  const chain = causeChain(error);
  if (chain.some(isDeadline)) return "timeout";
  if (chain.some((item) => item instanceof ProviderCancelledError)) return "caller_cancelled";
  const isAbort = chain.some(
    (item) =>
      (signal?.aborted && item === signal.reason) || stringField(item, "name") === "AbortError",
  );
  if (isAbort) {
    if (!signal?.aborted || isDeadline(signal.reason)) return "timeout";
    return "caller_cancelled";
  }
  if (stringField(error, "name") === "ZodError") return "invalid_payload";
  const code = stringField(error, "code");
  const byCode = code ? CODE_OUTCOMES[code] : undefined;
  if (byCode) return byCode;
  const status = numericField(error, "status") ?? numericField(error, "statusCode");
  if (status !== null) {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "quota";
    if (status >= 500) return "upstream_5xx";
    if (status >= 400) return "input";
  }
  return "connection";
}

/**
 * Settle with a cancellation as soon as the caller aborts, even when the
 * provider ignores its signal. Whichever settles first decides the outcome.
 */
export function raceCallerAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Abort provider work at a real deadline and also stop waiting if a provider
 * violates the signal contract. The abort is delivered before rejection.
 */
export async function runWithProviderDeadline<T>(
  call: (context: ProviderCallContext) => Promise<T>,
  options: ProviderDeadlineOptions,
): Promise<T> {
  const deadlineController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  const deadlineAt = Date.now() + options.timeoutMs;
  const timer = setTimeout(
    () => deadlineController.abort(new ProviderTimeoutError()),
    options.timeoutMs,
  );

  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw abortError(signal);
        return call({ signal, deadlineAt });
      }),
      aborted,
    ]);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}
