const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "mibextid",
  "ref",
  "refsrc",
  "si",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "yclid",
]);

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function stripHostPrefixes(hostname: string, prefixes = ["www"]): string {
  let host = normalizeHostname(hostname);
  for (;;) {
    const [first, ...rest] = host.split(".");
    if (!first || !prefixes.includes(first) || rest.length === 0) return host;
    host = rest.join(".");
  }
}

export function isBrandDomain(
  hostname: string,
  brand: string,
  options: { prefixes?: string[]; localized?: boolean } = {},
): boolean {
  const host = stripHostPrefixes(hostname, options.prefixes ?? ["www"]);
  const parts = host.split(".");
  if (parts[0] !== brand) return false;
  if (parts.length === 2) {
    return parts[1] === "com" || Boolean(options.localized && /^[a-z]{2,3}$/.test(parts[1]));
  }
  if (parts.length === 3) {
    return Boolean(
      options.localized && (parts[1] === "com" || parts[1] === "co") && /^[a-z]{2}$/.test(parts[2]),
    );
  }
  return false;
}

export function parseUrlLike(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withProtocol = /^https?:\/\//i.test(trimmed);
  const bareHost = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i.test(trimmed);
  if (!withProtocol && !bareHost) return undefined;
  try {
    return new URL(withProtocol ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
}

export function stripTrackingParams(url: URL, extraParams: readonly string[] = []): void {
  const strip = new Set([...TRACKING_PARAMS, ...extraParams.map((param) => param.toLowerCase())]);
  for (const key of Array.from(url.searchParams.keys())) {
    if (strip.has(key.toLowerCase())) url.searchParams.delete(key);
  }
}

export function sanitizePlatformUrl(
  url: URL,
  isAllowedHost: (hostname: string) => boolean,
  options: {
    requirePathOrSearch?: boolean;
    stripAllParams?: boolean;
    extraTrackingParams?: readonly string[];
  } = {},
): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!isAllowedHost(url.hostname)) return undefined;

  url.protocol = "https:";
  url.hash = "";
  if (options.stripAllParams) url.search = "";
  else stripTrackingParams(url, options.extraTrackingParams);

  if (options.requirePathOrSearch !== false && url.pathname === "/" && !url.search) {
    return undefined;
  }
  return url.toString();
}

export function encodePathPreservingSlashes(path: string): string | undefined {
  if (!path || /^\s*$/.test(path)) return undefined;
  if (/[\s<>\\]/.test(path)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  if (path.startsWith("//")) return undefined;

  const cleanPath = path.replace(/^\/+/, "").split(/[?#]/, 1)[0];
  if (!cleanPath) return undefined;

  return cleanPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
}
