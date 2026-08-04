import { createHash } from "node:crypto";

/**
 * Cache key for the shared integration HTTP client. Includes a digest of the
 * request URL and headers so requests that differ only in credentials or
 * locale never share a cached response. Neither raw header values nor the URL
 * query string may appear in the key: both can carry credentials in this
 * codebase (for example, several providers use `key`, `apikey`, or
 * `access_token` query parameters), and Redis keys surface in logs and
 * MONITOR output. The origin and path remain readable deliberately for
 * operability.
 */
function readableLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function httpCacheKey(url: string, headers?: Record<string, string>): string {
  const canonicalHeaders = Object.entries(headers ?? {})
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`)
    .join("\n");
  const digest = createHash("sha256")
    .update(`${url}\n${canonicalHeaders}`)
    .digest("hex")
    .slice(0, 32);
  return `int:http:${readableLabel(url)}#${digest}`;
}
