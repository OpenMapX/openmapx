import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { BlockList, isIP, SocketAddress } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
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
  url: URL;
  /** Absolute final path. Bytes are published with a same-directory atomic rename. */
  destination: string;
  headers?: Readonly<Record<string, string>>;
  /** Total wall-clock deadline across DNS, redirects, and body streaming. */
  timeoutMs: number;
  maxBytes: number;
  /** Empty means defer media validation to the downstream parser. */
  allowedContentTypes: readonly string[];
  credentialPolicy: "none" | "same-origin";
  signal?: AbortSignal;
}

export interface SafeDownloadResult {
  bytesWritten: number;
  finalUrl: URL;
  contentType: string | null;
}

const SAFE_DOWNLOAD_CLEANUP_ATTEMPTS = 3;
const SAFE_DOWNLOAD_CLEANUP_ATTEMPT_MS = 250;
const SAFE_DOWNLOAD_CLEANUP_TOTAL_MS = 1_500;

async function boundedSafeCleanupAttempt<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const operationPromise = Promise.resolve().then(operation);
  const remainingMs = Math.min(
    SAFE_DOWNLOAD_CLEANUP_ATTEMPT_MS,
    Math.max(0, deadlineAt - Date.now()),
  );
  if (remainingMs === 0) {
    void operationPromise.catch(() => {});
    throw new Error("safeDownload cleanup deadline exceeded");
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("safeDownload cleanup attempt timed out")),
      remainingMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelResponseBody(
  response: Response,
  deadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS,
): Promise<boolean> {
  try {
    await boundedSafeCleanupAttempt(async () => {
      await response.body?.cancel();
    }, deadlineAt);
    return true;
  } catch {
    return false;
  }
}

function blockList(
  ranges: ReadonlyArray<readonly [address: string, prefix: number]>,
  family: "ipv4" | "ipv6",
): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of ranges) list.addSubnet(address, prefix, family);
  return list;
}

// IANA special-purpose IPv4 ranges that are not ordinary public unicast
// destinations. Deliberately reject an entire special block even when it has
// a narrow anycast exception: ingestion needs general Internet endpoints, not
// protocol-assignment addresses.
const NON_PUBLIC_IPV4 = blockList(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ],
  "ipv4",
);

// IPv6 is fail-closed: only global-unicast 2000::/3 is eligible, with the
// special-purpose subranges inside it removed. IPv4-mapped forms are
// canonicalized by SocketAddress and classified by the IPv4 policy instead.
const GLOBAL_UNICAST_IPV6 = blockList([["2000::", 3]], "ipv6");
const NON_PUBLIC_IPV6_INSIDE_GLOBAL_UNICAST = blockList(
  [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3ffe::", 16],
    ["3fff::", 20],
  ],
  "ipv6",
);

function normalizeGloballyRoutableAddress(
  address: string,
  expectedFamily: 4 | 6,
): FetchConnectionAddress | undefined {
  const parsedFamily = isIP(address);
  if (parsedFamily !== expectedFamily) return undefined;
  const family = parsedFamily === 4 ? "ipv4" : "ipv6";
  let canonical: string;
  try {
    canonical = new SocketAddress({ address, family }).address;
  } catch {
    return undefined;
  }

  if (parsedFamily === 4) {
    if (NON_PUBLIC_IPV4.check(canonical, "ipv4")) return undefined;
    return { address: canonical, family: 4 };
  }

  const mapped = canonical.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) {
    if (NON_PUBLIC_IPV4.check(mapped[1], "ipv4")) return undefined;
    return { address: canonical, family: 6 };
  }
  if (!GLOBAL_UNICAST_IPV6.check(canonical, "ipv6")) return undefined;
  if (NON_PUBLIC_IPV6_INSIDE_GLOBAL_UNICAST.check(canonical, "ipv6")) return undefined;
  return { address: canonical, family: 6 };
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
  const normalized: FetchConnectionAddress[] = [];
  for (const { address, family } of addresses) {
    const approved = normalizeGloballyRoutableAddress(address, family);
    if (!approved) {
      throw new Error(`Hostname ${hostname} resolves to private IP/non-public address`);
    }
    normalized.push(approved);
  }
  return normalized;
}

export async function assertResolvesToPublicIp(hostname: string): Promise<void> {
  await resolvePublicAddresses(hostname);
}

const SAFE_DOWNLOAD_MAX_REDIRECTS = 5;
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);
const UNAUTHENTICATED_HEADER_ALLOWLIST = new Set(["accept", "user-agent"]);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Download aborted");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function assertAllowedDownloadUrl(url: URL): void {
  validatePublicUrl(url.toString());
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) {
    throw new Error(`URL host "${url.hostname}" uses a disallowed port`);
  }
}

function normalizedContentType(response: Response): string | null {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function headersForPolicy(
  headers: Readonly<Record<string, string>> | undefined,
  policy: SafeDownloadOptions["credentialPolicy"],
): Headers | undefined {
  if (!headers) return undefined;
  const normalized = new Headers(headers);
  if (policy === "none") {
    for (const name of [...normalized.keys()]) {
      if (CREDENTIAL_HEADER_NAMES.has(name) || !UNAUTHENTICATED_HEADER_ALLOWLIST.has(name)) {
        normalized.delete(name);
      }
    }
  }
  return normalized;
}

function temporaryDestination(destination: string): string {
  const token = `${process.pid}-${randomBytes(16).toString("hex")}`;
  return join(dirname(destination), `.${basename(destination)}.part-${token}`);
}

const pendingSafeDownloadCleanup = new Set<string>();

async function cleanupTemporaryFile(
  path: string,
  deadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS,
): Promise<void> {
  pendingSafeDownloadCleanup.add(path);
  let lastError: unknown;
  for (let attempt = 0; attempt < SAFE_DOWNLOAD_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const removal = Promise.resolve()
        .then(() => rm(path, { force: true }))
        .then(() => {
          pendingSafeDownloadCleanup.delete(path);
        });
      await boundedSafeCleanupAttempt(() => removal, deadlineAt);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("safeDownload temporary-file cleanup failed", { cause: lastError });
}

async function scavengePendingSafeDownloadFiles(
  deadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS,
): Promise<void> {
  const failures: unknown[] = [];
  for (const path of [...pendingSafeDownloadCleanup]) {
    try {
      await cleanupTemporaryFile(path, deadlineAt);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error("safeDownload temporary-file scavenging failed", { cause: failures[0] });
  }
}

interface NormalizedSafeDownload {
  url: URL;
  destination: string;
  headers?: Headers;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowedContentTypes: readonly string[];
  credentialPolicy: SafeDownloadOptions["credentialPolicy"];
  signal?: AbortSignal;
}

function normalizeSafeDownloadOptions(input: SafeDownloadOptions): NormalizedSafeDownload {
  return {
    ...input,
    url: new URL(input.url.toString()),
    headers: headersForPolicy(input.headers, input.credentialPolicy),
    maxRedirects: SAFE_DOWNLOAD_MAX_REDIRECTS,
  };
}

/**
 * Streams a URL to disk with SSRF protection: validates the initial URL, DNS-
 * resolves the hostname and rejects private IPs, follows redirects manually
 * through `fetchWithRedirects` so every `Location` is re-validated, and aborts
 * the stream when `maxBytes` is exceeded.
 */
export async function safeDownload(options: SafeDownloadOptions): Promise<SafeDownloadResult> {
  const opts = normalizeSafeDownloadOptions(options);
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new Error("safeDownload maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("safeDownload timeoutMs must be a positive safe integer");
  }
  if (!isAbsolute(opts.destination)) {
    throw new Error("safeDownload destination must be an absolute path");
  }
  const operationDeadlineAt = Date.now() + opts.timeoutMs;
  await scavengePendingSafeDownloadFiles(
    Math.min(operationDeadlineAt, Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS),
  );
  throwIfAborted(opts.signal);

  if (opts.credentialPolicy === "none") {
    opts.url.username = "";
    opts.url.password = "";
  }
  assertAllowedDownloadUrl(opts.url);
  const initialOrigin = opts.url.origin;
  const remainingOperationMs = Math.max(1, operationDeadlineAt - Date.now());
  const timeoutSignal = AbortSignal.timeout(remainingOperationMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  await abortable(resolvePublicHostOrThrow(opts.url.hostname), signal);
  const pinnedTransport = createPinnedFetchTransport();

  const fetchOpts: FetchWithRedirectsOptions = {
    headers: opts.headers,
    maxRedirects: opts.maxRedirects,
    signal,
    cleanupDeadlineAt: operationDeadlineAt,
    ...(opts.credentialPolicy === "same-origin" ? { allowedRedirectOrigin: initialOrigin } : {}),
    validateRedirectUrl: (nextUrl) => {
      assertAllowedDownloadUrl(nextUrl);
      return true;
    },
    resolveConnectionAddresses: async (nextUrl) => {
      throwIfAborted(signal);
      assertAllowedDownloadUrl(nextUrl);
      return abortable(resolvePublicHostOrThrow(nextUrl.hostname), signal);
    },
    pinnedFetchImplementation: pinnedTransport.fetch,
    releaseResponse: (response, options) =>
      pinnedTransport.releaseResponse(response, {
        ...options,
        cleanupDeadlineAt: operationDeadlineAt,
      }),
  };

  let response: Response | undefined;
  let temporary: string | undefined;
  let bodyConsumed = false;
  let bodyCancellationAttempted = false;
  let forceDestroy = false;
  let responseReleased = false;
  let transportDisposed = false;
  const cancelUnconsumedBody = async (cleanupDeadlineAt: number): Promise<void> => {
    if (!response || bodyConsumed || bodyCancellationAttempted) return;
    bodyCancellationAttempted = true;
    if (!(await cancelResponseBody(response, cleanupDeadlineAt))) forceDestroy = true;
  };
  const releaseResponse = async (cleanupDeadlineAt: number): Promise<void> => {
    if (!response || responseReleased) return;
    await pinnedTransport.releaseResponse(response, { force: forceDestroy, cleanupDeadlineAt });
    responseReleased = true;
  };
  const disposeTransport = async (cleanupDeadlineAt: number): Promise<void> => {
    if (transportDisposed) return;
    await pinnedTransport.dispose({ cleanupDeadlineAt });
    transportDisposed = true;
  };
  const cleanupResources = async (): Promise<unknown[]> => {
    const cleanupDeadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS;
    const transportCleanup = async (): Promise<void> => {
      const transportErrors: unknown[] = [];
      try {
        await cancelUnconsumedBody(cleanupDeadlineAt);
      } catch (error) {
        transportErrors.push(error);
      }
      try {
        await releaseResponse(cleanupDeadlineAt);
      } catch (error) {
        transportErrors.push(error);
      }
      try {
        await disposeTransport(cleanupDeadlineAt);
      } catch (error) {
        transportErrors.push(error);
      }
      if (transportErrors.length > 0) {
        throw new Error("safeDownload transport cleanup failed", {
          cause: transportErrors[0],
        });
      }
    };
    const results = await Promise.allSettled([
      transportCleanup(),
      ...(temporary ? [cleanupTemporaryFile(temporary, cleanupDeadlineAt)] : []),
    ]);
    const cleanupErrors = results.flatMap((cleanup) =>
      cleanup.status === "rejected" ? [cleanup.reason] : [],
    );
    return cleanupErrors;
  };
  let result: SafeDownloadResult;
  try {
    response = await fetchWithRedirects(opts.url, fetchOpts);

    if (!response.ok) {
      await cancelUnconsumedBody(operationDeadlineAt);
      throw new Error(
        `Download failed: HTTP ${response.status} ${response.statusText} from ${opts.url.hostname}`,
      );
    }

    const finalUrl = new URL(response.url || opts.url.toString());

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await cancelUnconsumedBody(operationDeadlineAt);
        throw new Error(
          `Declared Content-Length ${declared} exceeds max ${opts.maxBytes} bytes from ${finalUrl.hostname}`,
        );
      }
    }

    const contentType = normalizedContentType(response);
    const accepted = opts.allowedContentTypes.map((value) => value.trim().toLowerCase());
    if (accepted.length > 0 && (!contentType || !accepted.includes(contentType))) {
      await cancelUnconsumedBody(operationDeadlineAt);
      throw new Error(`Unexpected response content type from ${finalUrl.hostname}`);
    }

    if (!response.body) {
      throw new Error(`Empty response body from ${finalUrl.hostname}`);
    }

    let bytesWritten = 0;
    temporary = temporaryDestination(opts.destination);
    const fileStream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const nodeStream = Readable.fromWeb(
      response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    nodeStream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      if (bytesWritten > opts.maxBytes) {
        nodeStream.destroy(new Error(`Download exceeded max size of ${opts.maxBytes} bytes`));
      }
    });

    await pipeline(nodeStream, fileStream);
    bodyConsumed = true;
    throwIfAborted(signal);
    // Do not publish bytes until the socket-owning transport has settled. A
    // cleanup failure is a failed acquisition, not a usable stale download.
    const publicationCleanupDeadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS;
    await releaseResponse(publicationCleanupDeadlineAt);
    await disposeTransport(publicationCleanupDeadlineAt);
    await rename(temporary, opts.destination);
    temporary = undefined;

    result = { bytesWritten, finalUrl, contentType };
  } catch (error) {
    const cleanupErrors = await cleanupResources();
    if (cleanupErrors.length > 0 && error instanceof Error) {
      const existingCause = error.cause;
      Object.defineProperty(error, "cause", {
        configurable: true,
        value: new AggregateError(
          existingCause === undefined ? cleanupErrors : [existingCause, ...cleanupErrors],
          "safeDownload cleanup failed",
        ),
      });
    }
    if (cleanupErrors.length > 0 && !(error instanceof Error)) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "safeDownload operation and cleanup failed",
      );
    }
    throw error;
  }
  const cleanupErrors = await cleanupResources();
  if (cleanupErrors.length > 0) {
    throw new Error("safeDownload resource cleanup failed", { cause: cleanupErrors[0] });
  }
  return result;
}

export interface SafeFetchJsonOptions {
  /** Maximum bytes to buffer before rejecting. Default: 5 MB. */
  maxBytes?: number;
  /** Per-request timeout forwarded to the initial and each redirect fetch. Default: 15s. */
  timeoutMs?: number;
  /** Caller cancellation, combined with the request's total timeout. */
  signal?: AbortSignal;
  /** Cap on redirect hops. Default: 5. */
  maxRedirects?: number;
  /** Extra headers (e.g. `User-Agent`) to send on the first request. */
  headers?: Record<string, string>;
  /** HTTP method forwarded to the bounded request transport. */
  method?: string;
  /** String request body forwarded to the bounded request transport. */
  body?: string;
  /**
   * Return the decoded body without parsing it. Use when an untrusted body must
   * have its digest verified before it is allowed to reach `JSON.parse`.
   */
  parseJson?: boolean;
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
  /**
   * The exact decoded response body. A caller verifying a content digest must
   * hash these bytes rather than a re-serialization of `data`.
   */
  text: string;
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
  signal?: AbortSignal,
): Promise<FetchConnectionAddress[]> {
  signal?.throwIfAborted();
  const parsed = assertHttpProtocol(url);
  let resolution: Promise<FetchConnectionAddress[]>;
  if (isDeclaredPrivateHost(parsed.hostname, allowPrivateHosts)) {
    resolution = resolveHostname(parsed.hostname);
  } else {
    validatePublicUrl(url);
    resolution = resolvePublicHostOrThrow(parsed.hostname);
  }
  return signal ? abortable(resolution, signal) : resolution;
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
  const operationDeadlineAt = Date.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const operationSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  await assertFetchTargetAllowed(url, allowPrivateHosts, operationSignal);
  const { hostname } = new URL(url);
  const pinnedTransport = createPinnedFetchTransport();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyConsumed = false;
  let bodyCancellationAttempted = false;
  let forceDestroy = false;
  let responseReleased = false;
  let transportDisposed = false;
  let result: SafeJsonResponse<T> | undefined;
  let requestFailed = false;
  let primaryError: unknown;
  const cancelUnconsumedBody = async (cleanupDeadlineAt: number): Promise<void> => {
    if (!response || bodyConsumed || bodyCancellationAttempted) return;
    bodyCancellationAttempted = true;
    if (reader) {
      try {
        await boundedSafeCleanupAttempt(
          () => reader?.cancel() ?? Promise.resolve(),
          cleanupDeadlineAt,
        );
      } catch {
        forceDestroy = true;
      } finally {
        reader.releaseLock?.();
        reader = undefined;
      }
      return;
    }
    if (!(await cancelResponseBody(response, cleanupDeadlineAt))) forceDestroy = true;
  };
  const releaseResponse = async (cleanupDeadlineAt: number): Promise<void> => {
    if (!response || responseReleased) return;
    await pinnedTransport.releaseResponse(response, {
      force: forceDestroy,
      cleanupDeadlineAt,
    });
    responseReleased = true;
  };
  const disposeTransport = async (cleanupDeadlineAt: number): Promise<void> => {
    if (transportDisposed) return;
    await pinnedTransport.dispose({ cleanupDeadlineAt });
    transportDisposed = true;
  };
  const cleanupResources = async (): Promise<unknown[]> => {
    const cleanupDeadlineAt = Date.now() + SAFE_DOWNLOAD_CLEANUP_TOTAL_MS;
    const cleanupErrors: unknown[] = [];
    try {
      await cancelUnconsumedBody(cleanupDeadlineAt);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await releaseResponse(cleanupDeadlineAt);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await disposeTransport(cleanupDeadlineAt);
    } catch (error) {
      cleanupErrors.push(error);
    }
    return cleanupErrors;
  };

  try {
    const fetchImplementation = opts.fetchImplementation;
    response = await fetchWithRedirects(url, {
      headers: opts.headers,
      method: opts.method,
      body: opts.body,
      maxRedirects,
      timeoutMs: Math.max(1, operationDeadlineAt - Date.now()),
      signal: operationSignal,
      cleanupDeadlineAt: operationDeadlineAt,
      allowedRedirectHosts: opts.allowedRedirectHosts,
      allowedRedirectOrigin: opts.allowedRedirectOrigin,
      pinnedFetchImplementation: fetchImplementation
        ? (input, _addresses, init) => fetchImplementation(input, init)
        : pinnedTransport.fetch,
      releaseResponse: (redirectResponse, options) =>
        pinnedTransport.releaseResponse(redirectResponse, {
          ...options,
          cleanupDeadlineAt: operationDeadlineAt,
        }),
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
        assertFetchTargetAllowed(nextUrl.toString(), allowPrivateHosts, operationSignal),
    });

    const finalUrl = response.url || url;

    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      throw new SafeFetchHttpError(response.status, finalUrl, retryAfterSeconds);
    }

    const finalHostname = new URL(finalUrl).hostname;
    if (finalHostname !== hostname) {
      await assertFetchTargetAllowed(finalUrl, allowPrivateHosts, operationSignal);
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
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
        throw new Error(`Unexpected response content type for ${finalUrl}`);
      }
    }

    if (!response.body) {
      throw new Error(`Empty response body for ${finalUrl}`);
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await abortable(reader.read(), operationSignal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
    bodyConsumed = true;
    reader.releaseLock?.();
    reader = undefined;

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    if (opts.parseJson === false) {
      // The caller verifies a digest over these exact bytes before deciding
      // whether they may be parsed at all.
      result = {
        data: undefined as T,
        text,
        status: response.status,
        headers: response.headers,
        finalUrl,
      };
    } else {
      try {
        result = {
          data: JSON.parse(text) as T,
          text,
          status: response.status,
          headers: response.headers,
          finalUrl,
        };
      } catch {
        throw new Error(`Invalid JSON response from ${finalUrl}`);
      }
    }
  } catch (error) {
    requestFailed = true;
    primaryError = error;
  }

  const cleanupErrors = await cleanupResources();
  if (requestFailed) {
    if (cleanupErrors.length > 0 && primaryError instanceof Error) {
      Object.defineProperty(primaryError, "cause", {
        configurable: true,
        value: new AggregateError(cleanupErrors, "safeFetchJson cleanup failed"),
      });
    }
    if (cleanupErrors.length > 0 && !(primaryError instanceof Error)) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "safeFetchJson request and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error("safeFetchJson resource cleanup failed", { cause: cleanupErrors[0] });
  }
  if (!result) throw new Error("safeFetchJson response unavailable");
  return result;
}

// A full day bounds automatic retries while covering ordinary rate-limit windows.
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

/**
 * Fetch a URL through the same SSRF protection as `safeFetchJson` and return the
 * exact decoded body without parsing it. For content that must be digest-verified
 * before it is trusted enough to parse.
 */
export async function safeFetchText(
  url: string,
  opts: Omit<SafeFetchJsonOptions, "parseJson"> = {},
): Promise<string> {
  return (await safeFetchJsonResponse<unknown>(url, { ...opts, parseJson: false })).text;
}

/** Compatibility wrapper for callers that need only parsed JSON data. */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: SafeFetchJsonOptions = {},
): Promise<T> {
  return (await safeFetchJsonResponse<T>(url, opts)).data;
}
