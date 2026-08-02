/**
 * Parse a URL and reject anything that is not plain HTTP(S). Split out from
 * `validatePublicUrl` so callers that deliberately allow a private host (an
 * operator-declared internal feed mirror) still cannot be steered onto a
 * non-HTTP scheme.
 */
export function assertHttpProtocol(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  return parsed;
}

/**
 * Validates that a URL is a public HTTP(S) URL (not targeting internal/private addresses).
 * Used to prevent SSRF attacks when fetching user-supplied or externally-sourced URLs.
 */
export function validatePublicUrl(url: string): void {
  const parsed = assertHttpProtocol(url);
  const rawHostname = parsed.hostname;
  // Strip square brackets from IPv6 addresses (e.g. "[::1]" → "::1")
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
    /^::1$/,
    /^f[cd]/,
    /^fe80:/,
  ];
  if (
    hostname === "localhost" ||
    hostname === "" ||
    privateRanges.some((re) => re.test(hostname))
  ) {
    throw new Error("URLs targeting internal/private addresses are not allowed");
  }
}

/**
 * Check whether a URL is safe for server-side fetching (public, non-private).
 * Returns true if safe, false if the URL targets internal/private addresses.
 */
export function isPublicUrl(url: string): boolean {
  try {
    validatePublicUrl(url);
    return true;
  } catch {
    return false;
  }
}
