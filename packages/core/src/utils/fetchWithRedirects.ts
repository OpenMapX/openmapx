import {
  Agent,
  buildConnector,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  fetch as undiciFetch,
} from "undici";

export interface FetchConnectionAddress {
  address: string;
  family: 4 | 6;
}

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

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
  /**
   * Test-only or specialized transport override. Defaults to global fetch for
   * ordinary requests and to this package's Undici fetch when DNS is pinned.
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

function createPinnedDispatcher(addresses: FetchConnectionAddress[]): Dispatcher {
  if (!addresses.length) throw new Error("No validated addresses available for connection");
  const connector = buildConnector({});
  let nextAddress = 0;
  return new Agent({
    connect(options, callback) {
      const connectNext = (): void => {
        const address = addresses[nextAddress++];
        connector(
          {
            ...options,
            hostname: address.address,
            // Preserve the requested hostname for TLS certificate verification and SNI.
            servername: options.servername ?? options.hostname,
          },
          (error, socket) => {
            if (error) {
              if (nextAddress < addresses.length) {
                connectNext();
                return;
              }
              callback(error, null);
              return;
            }
            callback(null, socket);
          },
        );
      };
      connectNext();
    },
  });
}

function toRequestInit(
  init: FetchWithRedirectsOptions,
  dispatcher: Dispatcher | undefined,
): RequestInit & { dispatcher?: Dispatcher } {
  const {
    allowedRedirectHosts: _allowedRedirectHosts,
    allowedRedirectOrigin: _allowedRedirectOrigin,
    fetchImplementation: _fetchImplementation,
    follow203Redirect: _follow203Redirect,
    maxRedirects: _maxRedirects,
    resolveConnectionAddresses: _resolveConnectionAddresses,
    timeoutMs: _timeoutMs,
    validateRedirectUrl: _validateRedirectUrl,
    ...fetchInit
  } = init;
  return {
    ...fetchInit,
    ...(dispatcher ? { dispatcher } : {}),
    redirect: "manual",
    signal: withTimeoutSignal(init.signal, init.timeoutMs),
  };
}

function fetchWithPinnedDispatcher(
  input: string | URL,
  init: RequestInit & { dispatcher?: Dispatcher },
): Promise<Response> {
  // Node's global fetch may bundle a different Undici version. Pair this
  // package's fetch with the same-version Agent that owns the pinned socket.
  return undiciFetch(input, init as unknown as UndiciRequestInit) as unknown as Promise<Response>;
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
    const dispatcher = currentInit.resolveConnectionAddresses
      ? createPinnedDispatcher(await currentInit.resolveConnectionAddresses(new URL(currentUrl)))
      : undefined;
    const fetchImplementation =
      currentInit.fetchImplementation ??
      (dispatcher ? fetchWithPinnedDispatcher : globalThis.fetch);
    const response = await fetchImplementation(currentUrl, toRequestInit(currentInit, dispatcher));

    if (!isRedirectStatus(response.status, response, follow203Redirect)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    const previousUrl = new URL(currentUrl);
    const nextUrl = new URL(location, currentUrl);
    assertRedirectAllowed(nextUrl, previousUrl, currentInit);

    currentUrl = nextUrl.toString();
    currentInit = nextRequestInit(currentInit, response);
  }

  throw new Error(`Too many redirects while fetching ${currentUrl}`);
}
