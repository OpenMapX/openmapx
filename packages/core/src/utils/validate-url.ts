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

/** The eight 16-bit groups of an IPv6 literal without brackets, or null when it is not one. */
function ipv6Groups(literal: string): number[] | null {
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
      ? groups.map((group) => Number.parseInt(group, 16))
      : null;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...new Array<number>(gap).fill(0), ...tail] : null;
}

/**
 * Whether an IPv6 literal carries an IPv4 address in its last 32 bits in one of
 * the three forms that reach IPv4 hosts: mapped (`::ffff:a.b.c.d`), compatible
 * (`::a.b.c.d`, which includes `::` and `::1`) and translated (`::ffff:0:a.b.c.d`).
 * Node's URL parser writes these as hex groups such as `[::ffff:7f00:1]`, so
 * the textual IPv4 patterns never see them. A literal that cannot be read as
 * IPv6 is treated the same way.
 */
function embedsIpv4(literal: string): boolean {
  const groups = ipv6Groups(literal);
  if (!groups) return true;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const mapped = zeros(0, 5) && groups[5] === 0xffff;
  const compatible = zeros(0, 6);
  const translated = zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0;
  return mapped || compatible || translated;
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
    privateRanges.some((re) => re.test(hostname)) ||
    (hostname.includes(":") && embedsIpv4(hostname))
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
