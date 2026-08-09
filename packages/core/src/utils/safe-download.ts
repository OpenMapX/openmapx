import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type FetchConnectionAddress,
  type FetchImplementation,
  type FetchWithRedirectsOptions,
  fetchWithRedirects,
  hostMatchesAllowlist,
} from "./fetchWithRedirects";
import { createPinnedFetchTransport } from "./pinned-fetch";
import { assertHttpProtocol, validatePublicUrl } from "./validate-url";

export { hostMatchesAllowlist } from "./fetchWithRedirects";

export interface SafeDownloadOptions {
  /** Absolute path of the file to write. */
  destPath: string;
  /** Maximum bytes to accept; aborts mid-stream once exceeded. Default: 2 GB. */
  maxBytes?: number;
  /** Per-request timeout forwarded to the initial and each redirect fetch. Default: 5 minutes. */
  timeoutMs?: number;
  /** Cap on redirect hops. Default: 5. */
  maxRedirects?: number;
  /** Optional allowlist for redirect targets (passed through to fetchWithRedirects). */
  allowedRedirectHosts?: string[];
  /** Extra headers (e.g. `User-Agent`) to send on the first request. */
  headers?: Record<string, string>;
  /** Follow non-standard 203+Location redirects (some transit APIs). Default: false. */
  follow203Redirect?: boolean;
}

export interface SafeDownloadResult {
  bytesWritten: number;
  finalUrl: string;
  contentType: string | null;
}

async function cancelResponseBody(response: Response): Promise<boolean> {
  try {
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0, 0xffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xe0000000, 0xffffffff], // 224.0.0.0/4 + 240.0.0.0/4 (multicast, reserved)
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function isPrivateIpv4(address: number): boolean {
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => address >= lo && address <= hi);
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped form `::ffff:127.0.0.1`
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const ip = ipv4ToInt(mapped[1]);
    if (ip !== null && isPrivateIpv4(ip)) return true;
  }
  return false;
}

/**
 * Resolves `hostname` and throws if any returned address is private, loopback,
 * link-local, CGNAT, reserved, or IPv6 ULA/link-local. Closes the DNS-rebinding
 * window where `validatePublicUrl` approves a textual hostname but the actual
 * socket ends up on a private address.
 */
async function resolveHostname(hostname: string): Promise<FetchConnectionAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new Error(`No DNS records for ${hostname}`);
  }
  return addresses as FetchConnectionAddress[];
}

async function resolvePublicAddresses(hostname: string): Promise<FetchConnectionAddress[]> {
  const addresses = await resolveHostname(hostname);
  for (const { address, family } of addresses) {
    if (family === 4) {
      const int = ipv4ToInt(address);
      if (int === null || isPrivateIpv4(int)) {
        throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
      }
    } else if (family === 6) {
      if (isPrivateIpv6(address)) {
        throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
      }
    }
  }
  return addresses;
}

export async function assertResolvesToPublicIp(hostname: string): Promise<void> {
  await resolvePublicAddresses(hostname);
}

/**
 * Streams a URL to disk with SSRF protection: validates the initial URL, DNS-
 * resolves the hostname and rejects private IPs, follows redirects manually
 * through `fetchWithRedirects` so every `Location` is re-validated, and aborts
 * the stream when `maxBytes` is exceeded.
 */
export async function safeDownload(
  url: string,
  opts: SafeDownloadOptions,
): Promise<SafeDownloadResult> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const maxRedirects = opts.maxRedirects ?? 5;

  validatePublicUrl(url);
  const { hostname } = new URL(url);
  await resolvePublicAddresses(hostname);
  const pinnedTransport = createPinnedFetchTransport();

  const fetchOpts: FetchWithRedirectsOptions = {
    headers: opts.headers,
    maxRedirects,
    timeoutMs,
    follow203Redirect: opts.follow203Redirect,
    allowedRedirectHosts: opts.allowedRedirectHosts,
    validateRedirectUrl: (nextUrl) => {
      // Re-validate every redirect target against public-URL rules. DNS for the
      // redirected hostname is re-checked below on whichever response the loop
      // actually lands on.
      validatePublicUrl(nextUrl.toString());
      return true;
    },
    resolveConnectionAddresses: async (nextUrl) => {
      validatePublicUrl(nextUrl.toString());
      return resolvePublicAddresses(nextUrl.hostname);
    },
    pinnedFetchImplementation: pinnedTransport.fetch,
    releaseResponse: pinnedTransport.releaseResponse,
  };

  let response: Response | undefined;
  let bodyConsumed = false;
  let bodyCancellationAttempted = false;
  let forceDestroy = false;
  const cancelUnconsumedBody = async (): Promise<void> => {
    if (!response || bodyConsumed || bodyCancellationAttempted) return;
    bodyCancellationAttempted = true;
    if (!(await cancelResponseBody(response))) forceDestroy = true;
  };
  try {
    response = await fetchWithRedirects(url, fetchOpts);

    if (!response.ok) {
      await cancelUnconsumedBody();
      throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
    }

    const finalUrl = response.url || url;
    // Re-check DNS for the final host — it may differ from the initial hostname
    // after redirects.
    const finalHostname = new URL(finalUrl).hostname;
    if (finalHostname !== hostname) {
      await resolvePublicAddresses(finalHostname);
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await cancelUnconsumedBody();
        throw new Error(
          `Declared Content-Length ${declared} exceeds max ${maxBytes} for ${finalUrl}`,
        );
      }
    }

    if (!response.body) {
      throw new Error(`Empty response body for ${finalUrl}`);
    }

    let bytesWritten = 0;
    const fileStream = createWriteStream(opts.destPath);
    const nodeStream = Readable.fromWeb(
      response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    nodeStream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        nodeStream.destroy(new Error(`Download exceeded max size of ${maxBytes} bytes`));
      }
    });

    await pipeline(nodeStream, fileStream);
    bodyConsumed = true;

    return {
      bytesWritten,
      finalUrl,
      contentType: response.headers.get("content-type"),
    };
  } finally {
    await cancelUnconsumedBody();
    if (response) await pinnedTransport.releaseResponse(response, { force: forceDestroy });
    await pinnedTransport.dispose();
  }
}

export interface SafeFetchJsonOptions {
  /** Maximum bytes to buffer before rejecting. Default: 5 MB. */
  maxBytes?: number;
  /** Per-request timeout forwarded to the initial and each redirect fetch. Default: 15s. */
  timeoutMs?: number;
  /** Cap on redirect hops. Default: 5. */
  maxRedirects?: number;
  /** Extra headers (e.g. `User-Agent`) to send on the first request. */
  headers?: Record<string, string>;
  /**
   * Hostnames (exact or "*.suffix") permitted to resolve to a private address.
   * Defaults to `privateFeedHostAllowlist()` when omitted.
   */
  allowPrivateHosts?: string[];
  /**
   * Restrict redirect targets to these hosts. Pass this whenever the request
   * carries a credential header — otherwise a 302 from an otherwise-trusted
   * host hands the credential to whatever host the Location names.
   */
  allowedRedirectHosts?: string[];
  /** Require credential-bearing redirects to retain this exact origin. */
  allowedRedirectOrigin?: string;
  /**
   * Dependency-injection hook for a trusted transport. Production callers
   * should omit this so pinned requests use this package's Undici fetch.
   */
  fetchImplementation?: FetchImplementation;
  /** Optional allowlist of response media types, compared without parameters. */
  acceptedContentTypes?: string[];
}

export interface SafeJsonResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  finalUrl: string;
}

/** Safe metadata for non-success HTTP responses; deliberately excludes their body and request headers. */
export class SafeFetchHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly finalUrl: string;

  constructor(status: number, finalUrl: string, retryAfterSeconds: number | null) {
    super(`Request failed: HTTP ${status} for ${finalUrl}`);
    this.name = "SafeFetchHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.finalUrl = finalUrl;
  }
}

/**
 * Resolve `hostname` and reject private targets, rethrowing without the
 * resolved IP so an operator-facing error never echoes an internal address.
 */
async function resolvePublicHostOrThrow(hostname: string): Promise<FetchConnectionAddress[]> {
  try {
    return await resolvePublicAddresses(hostname);
  } catch {
    throw new Error(
      `URL host "${hostname}" is not allowed (private, internal, or unresolvable address)`,
    );
  }
}

/**
 * Hostnames an operator has explicitly declared safe to fetch even though they
 * resolve to a private address. Self-hosters legitimately run feed mirrors on a
 * LAN or CGNAT address; a hard public-IP requirement would break them, so the
 * bypass is opt-in and per host rather than global.
 *
 * Format: comma-separated exact hostnames or "*.suffix" wildcards.
 */
export function privateFeedHostAllowlist(): string[] {
  const raw = process.env.OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS;
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function isDeclaredPrivateHost(hostname: string, allowPrivateHosts: string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowPrivateHosts.some((allowed) => hostMatchesAllowlist(lower, allowed));
}

/**
 * Gate a fetch target: always HTTP(S), and public unless the operator declared
 * this specific host as an allowed private target.
 */
async function assertFetchTargetAllowed(
  url: string,
  allowPrivateHosts: string[],
): Promise<FetchConnectionAddress[]> {
  const parsed = assertHttpProtocol(url);
  if (isDeclaredPrivateHost(parsed.hostname, allowPrivateHosts)) {
    return resolveHostname(parsed.hostname);
  }
  validatePublicUrl(url);
  return resolvePublicHostOrThrow(parsed.hostname);
}

/**
 * Public form of the fetch-target gate, for callers that issue their own
 * request (streaming a large body, custom headers) but still need the URL
 * checked first. Same rule as `safeFetchJson`.
 */
export async function assertFeedUrlAllowed(
  url: string,
  allowPrivateHosts: string[] = privateFeedHostAllowlist(),
): Promise<void> {
  await assertFetchTargetAllowed(url, allowPrivateHosts);
}

/**
 * Fetch and JSON-parse a URL with the same SSRF protection as `safeDownload`:
 * textual public-URL validation, DNS resolution of the initial and final host
 * (rejecting private/link-local/reserved addresses), per-redirect re-validation
 * through `fetchWithRedirects`, and a byte cap (declared Content-Length + a
 * streaming counter). For fetching third-party-author-influenced JSON
 * (catalogs, manifests) from server-side code.
 */
export async function safeFetchJsonResponse<T = unknown>(
  url: string,
  opts: SafeFetchJsonOptions = {},
): Promise<SafeJsonResponse<T>> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowPrivateHosts = opts.allowPrivateHosts ?? privateFeedHostAllowlist();

  await assertFetchTargetAllowed(url, allowPrivateHosts);
  const { hostname } = new URL(url);
  const pinnedTransport = createPinnedFetchTransport();
  let response: Response | undefined;
  let bodyConsumed = false;
  let bodyCancellationAttempted = false;
  let forceDestroy = false;
  const cancelUnconsumedBody = async (): Promise<void> => {
    if (!response || bodyConsumed || bodyCancellationAttempted) return;
    bodyCancellationAttempted = true;
    if (!(await cancelResponseBody(response))) forceDestroy = true;
  };

  try {
    const fetchImplementation = opts.fetchImplementation;
    response = await fetchWithRedirects(url, {
      headers: opts.headers,
      maxRedirects,
      timeoutMs,
      allowedRedirectHosts: opts.allowedRedirectHosts,
      allowedRedirectOrigin: opts.allowedRedirectOrigin,
      pinnedFetchImplementation: fetchImplementation
        ? (input, _addresses, init) => fetchImplementation(input, init)
        : pinnedTransport.fetch,
      releaseResponse: pinnedTransport.releaseResponse,
      validateRedirectUrl: (nextUrl) => {
        const next = nextUrl.hostname;
        if (!isDeclaredPrivateHost(next, allowPrivateHosts)) {
          validatePublicUrl(nextUrl.toString());
        } else {
          assertHttpProtocol(nextUrl.toString());
        }
        return true;
      },
      resolveConnectionAddresses: (nextUrl) =>
        assertFetchTargetAllowed(nextUrl.toString(), allowPrivateHosts),
    });

    const finalUrl = response.url || url;

    if (!response.ok) {
      await cancelUnconsumedBody();
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      throw new SafeFetchHttpError(response.status, finalUrl, retryAfterSeconds);
    }

    const finalHostname = new URL(finalUrl).hostname;
    if (finalHostname !== hostname) {
      await assertFetchTargetAllowed(finalUrl, allowPrivateHosts);
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await cancelUnconsumedBody();
        throw new Error(`Response too large (declared ${declared} > ${maxBytes} bytes)`);
      }
    }

    if (opts.acceptedContentTypes) {
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const accepted = opts.acceptedContentTypes.map((value) => value.toLowerCase());
      if (!contentType || !accepted.includes(contentType)) {
        await cancelUnconsumedBody();
        throw new Error(`Unexpected response content type for ${finalUrl}`);
      }
    }

    if (!response.body) {
      throw new Error(`Empty response body for ${finalUrl}`);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          bodyCancellationAttempted = true;
          try {
            await reader.cancel();
          } catch {
            forceDestroy = true;
          }
          throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    bodyConsumed = true;

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    try {
      return {
        data: JSON.parse(text) as T,
        status: response.status,
        headers: response.headers,
        finalUrl,
      };
    } catch {
      throw new Error(`Invalid JSON response from ${finalUrl}`);
    }
  } finally {
    await cancelUnconsumedBody();
    if (response) await pinnedTransport.releaseResponse(response, { force: forceDestroy });
    await pinnedTransport.dispose();
  }
}

// A full day bounds automatic retries while covering ordinary rate-limit windows.
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

/** Compatibility wrapper for callers that need only parsed JSON data. */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: SafeFetchJsonOptions = {},
): Promise<T> {
  return (await safeFetchJsonResponse<T>(url, opts)).data;
}
