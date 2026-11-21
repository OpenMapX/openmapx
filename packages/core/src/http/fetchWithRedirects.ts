export interface FetchConnectionAddress {
  address: string;
  family: 4 | 6;
}

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

/**
 * A server-only transport that opens a socket using exactly `addresses`.
 * Kept structural so this client-facing module never imports a Node transport.
 */
export type PinnedFetchImplementation = (
  input: string | URL,
  addresses: FetchConnectionAddress[],
  init: RequestInit,
) => Promise<Response>;

export interface ReleaseResponseOptions {
  /** Destroy rather than gracefully close when response-body cancellation failed. */
  force?: boolean;
  /** Absolute wall-clock limit inherited from the owning operation. */
  cleanupDeadlineAt?: number;
}

/** Releases server-only resources associated with a response after its body is consumed or canceled. */
export type ReleaseResponse = (
  response: Response,
  options?: ReleaseResponseOptions,
) => Promise<void>;

export interface FetchWithRedirectsOptions extends Omit<RequestInit, "redirect"> {
  /**
   * Optional allowlist for redirect targets. Supports exact hostnames and
   * wildcard suffixes in the form "*.example.com".
   */
  allowedRedirectHosts?: string[];
  /** Require redirects to retain this exact scheme/host/port origin. */
  allowedRedirectOrigin?: string;
  maxRedirects?: number;
  timeoutMs?: number;
  validateRedirectUrl?: (nextUrl: URL, previousUrl: URL) => boolean;
  /** Resolve validated addresses immediately before each socket is opened. */
  resolveConnectionAddresses?: (url: URL) => Promise<FetchConnectionAddress[]>;
  /** Server-only socket-pinning transport paired with `resolveConnectionAddresses`. */
  pinnedFetchImplementation?: PinnedFetchImplementation;
  /** Server-only lifecycle callback, called after an intermediate redirect body is canceled. */
  releaseResponse?: ReleaseResponse;
  /** Absolute cleanup limit inherited from the request's total deadline. */
  cleanupDeadlineAt?: number;
  /**
   * Test-only or specialized transport override. Defaults to global fetch.
   * Pinned requests must instead provide `pinnedFetchImplementation`.
   */
  fetchImplementation?: FetchImplementation;
  /**
   * Some third-party APIs misuse HTTP 203 together with a Location header for
   * large-file redirects. When enabled, follow that Location manually.
   */
  follow203Redirect?: boolean;
}

function isRedirectStatus(status: number, response: Response, follow203Redirect: boolean): boolean {
  if ([301, 302, 303, 307, 308].includes(status)) return true;
  return follow203Redirect && status === 203 && Boolean(response.headers.get("location"));
}

function withTimeoutSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs?: number,
): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  const observedOperation = Promise.resolve(operation).then(
    (value) => ({ type: "resolved", value }) as const,
    (error) => ({ error, type: "rejected" }) as const,
  );
  signal.throwIfAborted();
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  try {
    const outcome = await Promise.race([observedOperation, aborted]);
    if (outcome.type === "rejected") throw outcome.error;
    return outcome.value;
  } finally {
    removeAbortListener?.();
  }
}

/**
 * Match a hostname against an allowlist entry: either an exact hostname or a
 * wildcard suffix in the form "*.example.com". Exported so callers that gate
 * credential forwarding use exactly the same rule as redirect gating.
 */
export function hostMatchesAllowlist(hostname: string, allowedHost: string): boolean {
  if (allowedHost.startsWith("*.")) {
    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === allowedHost;
}

function assertRedirectAllowed(
  nextUrl: URL,
  previousUrl: URL,
  options: FetchWithRedirectsOptions,
): void {
  if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
    throw new Error(`Redirect target protocol not allowed: ${nextUrl.protocol}`);
  }

  if (
    options.allowedRedirectHosts?.length &&
    !options.allowedRedirectHosts.some((allowedHost) =>
      hostMatchesAllowlist(nextUrl.hostname, allowedHost),
    )
  ) {
    throw new Error(`Redirect target not allowed: ${nextUrl.hostname}`);
  }

  if (
    options.allowedRedirectOrigin &&
    nextUrl.origin !== new URL(options.allowedRedirectOrigin).origin
  ) {
    throw new Error(`Redirect target origin not allowed: ${nextUrl.origin}`);
  }

  if (options.validateRedirectUrl && !options.validateRedirectUrl(nextUrl, previousUrl)) {
    throw new Error(`Redirect target rejected: ${nextUrl.toString()}`);
  }
}

function toRequestInit(
  init: FetchWithRedirectsOptions,
  requestSignal: AbortSignal | undefined,
): RequestInit {
  const {
    allowedRedirectHosts: _allowedRedirectHosts,
    allowedRedirectOrigin: _allowedRedirectOrigin,
    cleanupDeadlineAt: _cleanupDeadlineAt,
    fetchImplementation: _fetchImplementation,
    follow203Redirect: _follow203Redirect,
    maxRedirects: _maxRedirects,
    pinnedFetchImplementation: _pinnedFetchImplementation,
    releaseResponse: _releaseResponse,
    resolveConnectionAddresses: _resolveConnectionAddresses,
    timeoutMs: _timeoutMs,
    validateRedirectUrl: _validateRedirectUrl,
    ...fetchInit
  } = init;
  return {
    ...fetchInit,
    redirect: "manual",
    signal: requestSignal,
  };
}

const REDIRECT_CLEANUP_ATTEMPT_MS = 250;
const REDIRECT_CLEANUP_TOTAL_MS = 1_500;

async function boundedRedirectCleanupAttempt(
  operation: () => Promise<void>,
  deadlineAt: number,
): Promise<void> {
  const operationPromise = Promise.resolve().then(operation);
  const remainingMs = Math.min(REDIRECT_CLEANUP_ATTEMPT_MS, Math.max(0, deadlineAt - Date.now()));
  if (remainingMs === 0) {
    void operationPromise.catch(() => {});
    throw new Error("Redirect cleanup deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Redirect cleanup attempt timed out")), remainingMs);
    if (typeof timer === "object") timer.unref();
  });
  try {
    await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedRedirectRelease(
  operation: () => Promise<void>,
  deadlineAt: number,
): Promise<void> {
  const operationPromise = Promise.resolve().then(operation);
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    void operationPromise.catch(() => {});
    throw new Error("Redirect release deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Redirect release timed out")), remainingMs);
    if (typeof timer === "object") timer.unref();
  });
  try {
    await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function releaseRedirectResponse(
  response: Response,
  releaseResponse: ReleaseResponse | undefined,
  inheritedDeadlineAt: number | undefined,
): Promise<void> {
  const cleanupDeadlineAt = Math.min(
    inheritedDeadlineAt ?? Number.POSITIVE_INFINITY,
    Date.now() + REDIRECT_CLEANUP_TOTAL_MS,
  );
  let force = false;
  try {
    await boundedRedirectCleanupAttempt(async () => {
      await response.body?.cancel();
    }, cleanupDeadlineAt);
  } catch {
    force = true;
  }
  if (releaseResponse) {
    await boundedRedirectRelease(
      () => releaseResponse(response, { force, cleanupDeadlineAt }),
      cleanupDeadlineAt,
    );
  }
}

function retainLateFetchOwnership(
  operation: Promise<Response>,
  releaseResponse: ReleaseResponse | undefined,
): void {
  void operation
    .then(
      (response) => releaseRedirectResponse(response, releaseResponse, undefined),
      () => undefined,
    )
    .catch(() => {});
}

async function awaitFetchResponse(
  operation: Promise<Response>,
  signal: AbortSignal | undefined,
  releaseResponse: ReleaseResponse | undefined,
): Promise<Response> {
  if (!signal) return operation;
  const responseOperation = Promise.resolve(operation);
  const fetched = responseOperation.then(
    (response) => ({ response, type: "response" }) as const,
    (error) => ({ error, type: "failed" }) as const,
  );
  if (signal.aborted) {
    retainLateFetchOwnership(responseOperation, releaseResponse);
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
      retainLateFetchOwnership(responseOperation, releaseResponse);
      throw outcome.reason ?? new Error("request aborted");
    }
    if (outcome.type === "failed") throw outcome.error;
    if (signal.aborted) {
      await releaseRedirectResponse(outcome.response, releaseResponse, undefined);
      signal.throwIfAborted();
    }
    return outcome.response;
  } finally {
    removeAbortListener?.();
  }
}

function nextRequestInit(
  init: FetchWithRedirectsOptions,
  response: Response,
): FetchWithRedirectsOptions {
  if (response.status !== 303) return init;
  const headers = new Headers(init.headers);
  return {
    ...init,
    method: "GET",
    body: undefined,
    headers,
  };
}

export async function fetchWithRedirects(
  input: string | URL,
  options: FetchWithRedirectsOptions = {},
): Promise<Response> {
  const maxRedirects = Math.max(0, options.maxRedirects ?? 8);
  const follow203Redirect = options.follow203Redirect ?? false;
  let currentUrl = typeof input === "string" ? input : input.toString();
  let currentInit: FetchWithRedirectsOptions = {
    ...options,
    headers: options.headers ? new Headers(options.headers) : undefined,
  };

  for (let i = 0; i <= maxRedirects; i++) {
    const requestSignal = withTimeoutSignal(currentInit.signal, currentInit.timeoutMs);
    requestSignal?.throwIfAborted();
    const addresses = currentInit.resolveConnectionAddresses
      ? await abortable(currentInit.resolveConnectionAddresses(new URL(currentUrl)), requestSignal)
      : undefined;
    const requestInit = toRequestInit(currentInit, requestSignal);
    requestSignal?.throwIfAborted();
    const fetchPromise = addresses
      ? currentInit.pinnedFetchImplementation
        ? currentInit.pinnedFetchImplementation(currentUrl, addresses, requestInit)
        : (() => {
            if (!currentInit.fetchImplementation) {
              throw new Error("Pinned requests require a pinned fetch implementation");
            }
            return currentInit.fetchImplementation(currentUrl, requestInit);
          })()
      : (currentInit.fetchImplementation ?? globalThis.fetch)(currentUrl, requestInit);
    const response = await awaitFetchResponse(
      fetchPromise,
      requestSignal,
      currentInit.releaseResponse,
    );

    if (!isRedirectStatus(response.status, response, follow203Redirect)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    let nextUrl: URL;
    try {
      const previousUrl = new URL(currentUrl);
      nextUrl = new URL(location, currentUrl);
      assertRedirectAllowed(nextUrl, previousUrl, currentInit);
      if (i === maxRedirects) {
        throw new Error(`Too many redirects while fetching ${currentUrl}`);
      }
    } catch (error) {
      await releaseRedirectResponse(
        response,
        currentInit.releaseResponse,
        currentInit.cleanupDeadlineAt,
      );
      throw error;
    }

    await releaseRedirectResponse(
      response,
      currentInit.releaseResponse,
      currentInit.cleanupDeadlineAt,
    );

    currentUrl = nextUrl.toString();
    currentInit = nextRequestInit(currentInit, response);
  }

  throw new Error(`Too many redirects while fetching ${currentUrl}`);
}
