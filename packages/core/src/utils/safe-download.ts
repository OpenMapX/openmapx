import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type FetchWithRedirectsOptions, fetchWithRedirects } from "./fetchWithRedirects";
import { validatePublicUrl } from "./validate-url";

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
export async function assertResolvesToPublicIp(hostname: string): Promise<void> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new Error(`No DNS records for ${hostname}`);
  }
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
  await assertResolvesToPublicIp(hostname);

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
  };

  const response = await fetchWithRedirects(url, fetchOpts);

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
  }

  const finalUrl = response.url || url;
  // Re-check DNS for the final host — it may differ from the initial hostname
  // after redirects.
  const finalHostname = new URL(finalUrl).hostname;
  if (finalHostname !== hostname) {
    await assertResolvesToPublicIp(finalHostname);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
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

  return {
    bytesWritten,
    finalUrl,
    contentType: response.headers.get("content-type"),
  };
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
}

/**
 * Resolve `hostname` and reject private targets, rethrowing without the
 * resolved IP so an operator-facing error never echoes an internal address.
 */
async function assertPublicHostOrThrow(hostname: string): Promise<void> {
  try {
    await assertResolvesToPublicIp(hostname);
  } catch {
    throw new Error(
      `URL host "${hostname}" is not allowed (private, internal, or unresolvable address)`,
    );
  }
}

/**
 * Fetch and JSON-parse a URL with the same SSRF protection as `safeDownload`:
 * textual public-URL validation, DNS resolution of the initial and final host
 * (rejecting private/link-local/reserved addresses), per-redirect re-validation
 * through `fetchWithRedirects`, and a byte cap (declared Content-Length + a
 * streaming counter). For fetching third-party-author-influenced JSON
 * (catalogs, manifests) from server-side code.
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: SafeFetchJsonOptions = {},
): Promise<T> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 5;

  validatePublicUrl(url);
  const { hostname } = new URL(url);
  await assertPublicHostOrThrow(hostname);

  const response = await fetchWithRedirects(url, {
    headers: opts.headers,
    maxRedirects,
    timeoutMs,
    validateRedirectUrl: (nextUrl) => {
      validatePublicUrl(nextUrl.toString());
      return true;
    },
  });

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new Error(`Request failed: HTTP ${response.status} for ${url}`);
  }

  const finalUrl = response.url || url;
  const finalHostname = new URL(finalUrl).hostname;
  if (finalHostname !== hostname) {
    await assertPublicHostOrThrow(finalHostname);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      throw new Error(`Response too large (declared ${declared} > ${maxBytes} bytes)`);
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
        await reader.cancel().catch(() => {});
        throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${finalUrl}`);
  }
}
