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

/** Releases server-only resources associated with a response after its body is consumed or canceled. */
export type ReleaseResponse = (response: Response) => Promise<void>;

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

function toRequestInit(init: FetchWithRedirectsOptions): RequestInit {
  const {
    allowedRedirectHosts: _allowedRedirectHosts,
    allowedRedirectOrigin: _allowedRedirectOrigin,
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
    signal: withTimeoutSignal(init.signal, init.timeoutMs),
  };
}

async function releaseRedirectResponse(
  response: Response,
  releaseResponse: ReleaseResponse | undefined,
): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed cancellation must not leave the server-only dispatcher alive.
  } finally {
    await releaseResponse?.(response);
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
    const addresses = currentInit.resolveConnectionAddresses
      ? await currentInit.resolveConnectionAddresses(new URL(currentUrl))
      : undefined;
    const requestInit = toRequestInit(currentInit);
    const response = addresses
      ? await (currentInit.pinnedFetchImplementation
          ? currentInit.pinnedFetchImplementation(currentUrl, addresses, requestInit)
          : (() => {
              if (!currentInit.fetchImplementation) {
                throw new Error("Pinned requests require a pinned fetch implementation");
              }
              return currentInit.fetchImplementation(currentUrl, requestInit);
            })())
      : await (currentInit.fetchImplementation ?? globalThis.fetch)(currentUrl, requestInit);

    if (!isRedirectStatus(response.status, response, follow203Redirect)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    const previousUrl = new URL(currentUrl);
    const nextUrl = new URL(location, currentUrl);
    try {
      assertRedirectAllowed(nextUrl, previousUrl, currentInit);
      if (i === maxRedirects) {
        throw new Error(`Too many redirects while fetching ${currentUrl}`);
      }
    } catch (error) {
      await releaseRedirectResponse(response, currentInit.releaseResponse);
      throw error;
    }

    await releaseRedirectResponse(response, currentInit.releaseResponse);

    currentUrl = nextUrl.toString();
    currentInit = nextRequestInit(currentInit, response);
  }

  throw new Error(`Too many redirects while fetching ${currentUrl}`);
}
