/**
 * Validates that a URL is a public HTTP(S) URL (not targeting internal/private addresses).
 * Used to prevent SSRF attacks when downloading user-supplied URLs.
 */
export function validatePublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
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
