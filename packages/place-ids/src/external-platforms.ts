import {
  isBrandDomain,
  normalizeHostname,
  parseUrlLike,
  sanitizePlatformUrl,
  stripTrackingParams,
} from "./platform-url";

const GOOGLE_CID_RE = /^\d{5,30}$/;
const YELP_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/i;
const FOURSQUARE_ID_RE = /^[a-f0-9]{24}$/i;
const INSTAGRAM_HANDLE_RE = /^[a-z0-9._]{1,30}$/i;
const FACEBOOK_NUMERIC_ID_RE = /^\d{5,30}$/;
const FACEBOOK_SLUG_RE = /^[a-z0-9][a-z0-9._-]{2,99}$/i;

const INSTAGRAM_RESERVED_PATHS = new Set(["accounts", "explore", "p", "reel", "stories", "tv"]);

const FACEBOOK_RESERVED_PATHS = new Set([
  "about",
  "ajax",
  "events",
  "friends",
  "groups",
  "help",
  "home",
  "login",
  "marketplace",
  "messages",
  "people",
  "photo",
  "photos",
  "plugins",
  "privacy",
  "reel",
  "search",
  "share",
  "sharer",
  "watch",
]);

function firstPathSegment(pathname: string): string | undefined {
  return pathname.split("/").filter(Boolean)[0];
}

function hasSinglePathSegment(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).length === 1;
}

function sanitizeSlug(value: string): string | undefined {
  const slug = value.trim().replace(/^\/+/, "").split(/[/?#]/, 1)[0];
  return slug || undefined;
}

function parsePlatformUrl(value: string, bareHostPattern: RegExp): URL | undefined {
  if (!/^https?:\/\//i.test(value) && !bareHostPattern.test(value)) return undefined;
  return parseUrlLike(value);
}

function isGoogleMapsHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "maps.app.goo.gl") return true;
  if (host === "goo.gl") return true;
  const withoutWww = host.replace(/^www\./, "");
  if (withoutWww.startsWith("maps.")) {
    return isBrandDomain(withoutWww.slice("maps.".length), "google", { localized: true });
  }
  return isBrandDomain(withoutWww, "google", { localized: true });
}

function isGoogleMapsUrl(url: URL): boolean {
  const host = normalizeHostname(url.hostname);
  if (host === "maps.app.goo.gl") return url.pathname !== "/";
  if (host === "goo.gl") return url.pathname.startsWith("/maps/");
  if (!isGoogleMapsHost(host)) return false;
  if (host.replace(/^www\./, "").startsWith("maps.")) return true;
  return url.pathname === "/maps" || url.pathname.startsWith("/maps/");
}

function isYelpHost(hostname: string): boolean {
  return isBrandDomain(hostname, "yelp", { localized: true });
}

function isFoursquareHost(hostname: string): boolean {
  const host = normalizeHostname(hostname).replace(/^www\./, "");
  return host === "foursquare.com" || host === "4sq.com";
}

function isInstagramHost(hostname: string): boolean {
  return normalizeHostname(hostname).replace(/^www\./, "") === "instagram.com";
}

function isFacebookHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "facebook.com" ||
    host === "www.facebook.com" ||
    host === "m.facebook.com" ||
    host === "fb.com" ||
    host === "www.fb.com"
  );
}

export function buildGoogleMapsUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parsePlatformUrl(
    trimmed,
    /^(?:(?:www\.)?(?:maps\.)?google\.[a-z]|maps\.app\.goo\.gl|goo\.gl)/i,
  );
  if (url) {
    if (!isGoogleMapsUrl(url)) return undefined;
    return sanitizePlatformUrl(url, isGoogleMapsHost);
  }

  if (!GOOGLE_CID_RE.test(trimmed)) return undefined;
  return `https://www.google.com/maps?cid=${encodeURIComponent(trimmed)}`;
}

export function buildYelpUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parsePlatformUrl(trimmed, /^(?:www\.)?yelp\.[a-z]/i);
  if (url) {
    if (!isYelpHost(url.hostname)) return undefined;
    if (!url.pathname.startsWith("/biz/")) return undefined;
    return sanitizePlatformUrl(url, isYelpHost, { stripAllParams: true });
  }

  const slug = sanitizeSlug(trimmed);
  if (!slug || !YELP_SLUG_RE.test(slug)) return undefined;
  return `https://www.yelp.com/biz/${encodeURIComponent(slug)}`;
}

export function buildFoursquareUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parsePlatformUrl(trimmed, /^(?:www\.)?(?:foursquare\.com|4sq\.com)(?:[/:?#]|$)/i);
  if (url) return sanitizePlatformUrl(url, isFoursquareHost, { stripAllParams: true });

  if (!FOURSQUARE_ID_RE.test(trimmed)) return undefined;
  return `https://foursquare.com/v/${encodeURIComponent(trimmed)}`;
}

export function buildInstagramUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parsePlatformUrl(trimmed, /^(?:www\.)?instagram\.com(?:[/:?#]|$)/i);
  if (url) {
    if (!isInstagramHost(url.hostname)) return undefined;
    const handle = firstPathSegment(url.pathname);
    if (!handle || !hasSinglePathSegment(url.pathname)) return undefined;
    if (INSTAGRAM_RESERVED_PATHS.has(handle.toLowerCase())) return undefined;
    if (!INSTAGRAM_HANDLE_RE.test(handle)) return undefined;
    return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  }

  const handle = trimmed.replace(/^@+/, "");
  if (!INSTAGRAM_HANDLE_RE.test(handle)) return undefined;
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}

function facebookUrlFromPath(url: URL): string | undefined {
  if (url.pathname === "/profile.php") {
    const id = url.searchParams.get("id")?.trim();
    if (!id || !FACEBOOK_NUMERIC_ID_RE.test(id)) return undefined;
    return `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0]?.toLowerCase();
  if (!first) return undefined;

  if (first === "pages" && parts.length >= 3) {
    const id = parts.at(-1);
    if (!id || !FACEBOOK_NUMERIC_ID_RE.test(id)) return undefined;
    return `https://www.facebook.com/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
  }

  if (parts.length !== 1) return undefined;
  const slug = parts[0];
  if (FACEBOOK_RESERVED_PATHS.has(slug.toLowerCase())) return undefined;
  if (!FACEBOOK_SLUG_RE.test(slug)) return undefined;
  return `https://www.facebook.com/${encodeURIComponent(slug)}`;
}

export function buildFacebookUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parsePlatformUrl(trimmed, /^(?:www\.|m\.)?(?:facebook|fb)\.com(?:[/:?#]|$)/i);
  if (url) {
    if (!isFacebookHost(url.hostname)) return undefined;
    stripTrackingParams(url);
    return facebookUrlFromPath(url);
  }

  if (FACEBOOK_NUMERIC_ID_RE.test(trimmed)) {
    return `https://www.facebook.com/profile.php?id=${encodeURIComponent(trimmed)}`;
  }

  const slug = sanitizeSlug(trimmed);
  if (!slug || FACEBOOK_RESERVED_PATHS.has(slug.toLowerCase())) return undefined;
  if (!FACEBOOK_SLUG_RE.test(slug)) return undefined;
  return `https://www.facebook.com/${encodeURIComponent(slug)}`;
}
