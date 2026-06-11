import { createHash } from "node:crypto";

/**
 * Cache key for the shared integration HTTP client. Includes a digest of the
 * request headers so requests that differ only in header-borne credentials or
 * locale never share a cached response. Raw header values must never appear
 * in the key — they can contain secrets and Redis keys show up in logs and
 * MONITOR output.
 */
export function httpCacheKey(url: string, headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return `int:http:${url}`;
  const canonical = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`)
    .join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `int:http:${url}#h=${digest}`;
}
