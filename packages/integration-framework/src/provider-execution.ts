import type { ZodType } from "zod";
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

/**
 * The host retired the setup generation serving a call, as on reload or
 * shutdown. Hosts abort generation-owned signals with this reason so the
 * interrupted call reads as a cancellation, never as a provider failure.
 */
export class ProviderRetiredError extends Error {
  constructor() {
    super("provider generation retired");
    this.name = "ProviderRetiredError";
  }
}

/**
 * The caller's request was bad input: a value the adapter rejected itself, or
 * an upstream "not found" for an identifier the caller supplied. Provider
 * health records it as the non-counted `input` outcome, so repeated bogus
 * identifiers cannot open a provider's circuit. Throw it only where the adapter
 * knows the identifier came from the caller; a 404 on a fixed endpoint is a
 * provider failure.
 */
export class ProviderInputError extends Error {
  readonly code = "invalid_request";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderInputError";
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

function issuePath(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: PropertyKey[] }> } | null)?.issues;
  const path = issues?.[0]?.path?.map(String).join(".");
  return path ? ` at ${path}` : "";
}

/** Parse the fields a provider consumes, or throw a `ProviderPayloadError`. */
export function parseProviderPayload<T>(schema: ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ProviderPayloadError(`${what}: unexpected response shape${issuePath(parsed.error)}`, {
      cause: parsed.error,
    });
  return parsed.data;
}

/**
 * Keep the records that carry every consumed field and drop the rest, so one
 * malformed row does not hide its valid neighbours. A non-empty list with no
 * usable record is a malformed payload, not an empty result.
 */
export function parseProviderRecords<T>(
  schema: ZodType<T>,
  records: readonly unknown[],
  what: string,
): T[] {
  const kept: T[] = [];
  let firstError: unknown;
  for (const record of records) {
    const parsed = schema.safeParse(record);
    if (parsed.success) kept.push(parsed.data);
    else firstError ??= parsed.error;
  }
  if (records.length > 0 && kept.length === 0)
    throw new ProviderPayloadError(`${what}: no usable records${issuePath(firstError)}`, {
      cause: firstError,
    });
  return kept;
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

function stringField(error: unknown, field: "code" | "kind" | "name"): string | null {
  if (!error || typeof error !== "object" || !(field in error)) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

const CODE_OUTCOMES: Readonly<Record<string, ProviderHealthFailureOutcome>> = {
  quota_exhausted: "quota",
  invalid_response: "invalid_payload",
  invalid_payload: "invalid_payload",
  // The adapter rejected the caller's request itself, before any upstream call.
  invalid_request: "input",
  unauthorized: "auth",
  forbidden: "auth",
  upstream_failure: "connection",
  ACCESS_DENIED: "auth",
  SERVER_ERROR: "upstream_5xx",
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
};

/**
 * Adapter clients that convert an aborted signal into their own error carry
 * `kind: "cancelled"` or `kind: "timeout"` (the OTP and MBTA clients do).
 */
const KIND_OUTCOMES: Readonly<Record<string, ProviderHealthFailureOutcome>> = {
  cancelled: "caller_cancelled",
  timeout: "timeout",
};

/**
 * Map a failed provider call to the health outcome it should record.
 *
 * The error that settled the call decides. A cancellation becomes
 * `caller_cancelled`, which orchestrators record in metrics only and never in
 * provider health. That covers the caller's abort when the error itself is that
 * abort (directly, by name or through its cause chain) while the caller's
 * signal is aborted, the host retiring the generation (`ProviderRetiredError`),
 * and an adapter error of kind `cancelled`. An upstream failure that settled
 * first keeps its own outcome even if the caller aborts before it is
 * classified. Deadlines are timeouts, whoever set them, and an abort neither
 * the caller nor the host requested is the provider's own deadline.
 *
 * Upstream 4xx responses other than 401, 403 and 429 count as `connection`
 * failures: a retired endpoint or a broken request builder must be able to open
 * the circuit. Only a request the adapter itself knows is bad caller input
 * (code `invalid_request`) is the non-counted `input`.
 */
export function classifyProviderFailure(
  error: unknown,
  signal?: AbortSignal,
): ProviderHealthFailureOutcome {
  const chain = causeChain(error);
  if (chain.some(isDeadline)) return "timeout";
  if (
    chain.some(
      (item) => item instanceof ProviderCancelledError || item instanceof ProviderRetiredError,
    )
  )
    return "caller_cancelled";
  const isAbort = chain.some(
    (item) =>
      (signal?.aborted && item === signal.reason) || stringField(item, "name") === "AbortError",
  );
  if (isAbort) {
    if (!signal?.aborted || isDeadline(signal.reason)) return "timeout";
    return "caller_cancelled";
  }
  // Adapters wrap upstream errors to keep credential-bearing URLs out of
  // messages, so the structured code or status may sit on a cause.
  for (const item of chain) {
    if (stringField(item, "name") === "ZodError") return "invalid_payload";
    const code = stringField(item, "code");
    const byCode = code ? CODE_OUTCOMES[code] : undefined;
    if (byCode) return byCode;
    const kind = stringField(item, "kind");
    const byKind = kind ? KIND_OUTCOMES[kind] : undefined;
    if (byKind) return byKind;
    const status = numericField(item, "status") ?? numericField(item, "statusCode");
    if (status !== null) {
      if (status === 401 || status === 403) return "auth";
      if (status === 429) return "quota";
      if (status >= 500) return "upstream_5xx";
    }
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
