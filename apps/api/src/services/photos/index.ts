import type { PlacePhoto } from "@openmapx/core";
import { getIntegrationsByDomain } from "../../integration-host.js";
import type { PhotoProvider, PhotoQuery } from "./types";

/**
 * Collect photo providers from all integrations registered under the "photos" domain.
 */
function getPhotoProviders(): PhotoProvider[] {
  const providers: PhotoProvider[] = [];
  for (const integration of getIntegrationsByDomain("photos")) {
    for (const p of (integration.providers.get("photos") ?? []) as PhotoProvider[]) {
      providers.push(p);
    }
  }
  return providers;
}

/**
 * Queries all photo sources and returns a single merged, deduplicated list.
 *
 * Photo providers handle both coordinate-based and tag-based lookups internally.
 * When `osmTags` are provided in the query, providers that support tag-based
 * lookups will include those results with higher priority.
 *
 * Never throws — individual provider failures are silently dropped.
 */
export async function searchPhotos(query: PhotoQuery): Promise<PlacePhoto[]> {
  const providers = getPhotoProviders();

  const totalLimit = query.limit ?? 20;
  const perProvider = Math.max(6, Math.ceil(totalLimit / Math.max(providers.length, 1)));

  const results = await Promise.allSettled(
    providers.map((p) => p.search({ ...query, limit: perProvider })),
  );

  // OSM image tags first (highest priority), then provider results
  const all: PlacePhoto[] = [];
  if (query.osmTags) all.push(...(await extractImageTagPhotos(query.osmTags)));
  for (const result of results) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  return deduplicatePhotos(all, totalLimit);
}

/**
 * Fast tag-based photo lookup for hero images on place detail pages.
 * Only calls providers that support searchByTags — no geo-search, no coordinate queries.
 * Never throws — individual provider failures are silently dropped.
 */
export async function searchHeroPhotos(osmTags: Record<string, string>): Promise<PlacePhoto[]> {
  const providers = getPhotoProviders();

  // OSM image tags first
  const imageTagPhotos = await extractImageTagPhotos(osmTags);

  // Tag-based lookups from providers that support it
  const tagPromises: Promise<PlacePhoto[]>[] = [];
  for (const p of providers) {
    if (p.searchByTags) tagPromises.push(p.searchByTags(osmTags));
  }
  const results = await Promise.allSettled(tagPromises);

  const all: PlacePhoto[] = [...imageTagPhotos];
  for (const result of results) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  return deduplicatePhotos(all, 6);
}

/**
 * Extract photos from OSM `image` tags.
 * Handles: `image`, `image:0`, `image:1`, …
 * Values can be direct URLs, Wikimedia Commons filenames, or Google Photos share links.
 */
async function extractImageTagPhotos(tags: Record<string, string>): Promise<PlacePhoto[]> {
  const photos: PlacePhoto[] = [];
  const seen = new Set<string>();

  // Collect image tag values in order: image, image:0, image:1, …
  const imageValues: string[] = [];
  if (tags.image) imageValues.push(tags.image);
  for (let i = 0; i <= 20; i++) {
    const v = tags[`image:${i}`];
    if (v) imageValues.push(v);
  }

  // Resolve all values (some may be async, e.g. Google Photos links)
  const resolved = await Promise.allSettled(imageValues.map((raw) => resolveImageValue(raw)));

  for (let i = 0; i < resolved.length; i++) {
    const result = resolved[i];
    if (result.status !== "fulfilled" || !result.value) continue;
    const rawValue = imageValues[i];
    const isGooglePhotos =
      rawValue.includes("photos.app.goo.gl") || rawValue.includes("photos.google.com/share");
    for (const url of result.value) {
      if (seen.has(url)) continue;
      seen.add(url);
      photos.push({
        url,
        attribution: isGooglePhotos ? "Google Photos" : "OpenStreetMap",
        source: isGooglePhotos ? "google-photos" : "osm",
        pageUrl: isGooglePhotos ? rawValue : undefined,
      });
    }
  }

  return photos;
}

/**
 * Resolve an OSM image tag value to one or more displayable URLs.
 * Handles direct URLs, Wikimedia Commons filenames, and Google Photos share links.
 */
async function resolveImageValue(value: string): Promise<string[] | null> {
  // Wikimedia Commons filename: "File:Example.jpg"
  if (value.startsWith("File:")) {
    const filename = value.slice(5);
    return [
      `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=1200`,
    ];
  }

  // Not a URL
  if (!value.startsWith("http://") && !value.startsWith("https://")) return null;

  // Google Photos share link → resolve og:image preview only.
  // Full album extraction is implemented (extractGoogleUserContentUrls) but
  // disabled for legal reasons (Google ToS, photographer copyright).
  // We only use the og:image which is intended for link-preview embedding.
  if (value.includes("photos.app.goo.gl") || value.includes("photos.google.com/share")) {
    const preview = await resolveGooglePhotosPreview(value);
    return preview ? [preview] : null;
  }

  return [value];
}

// Browser-like headers to avoid Google blocking server-side fetches
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Resolve a Google Photos share link to actual image URLs.
 * Exported so the image proxy can use it as a fallback.
 */
export async function resolveGooglePhotosLink(shareUrl: string): Promise<string[]> {
  try {
    // Step 1: For short URLs (photos.app.goo.gl), follow the redirect manually
    // to get the actual photos.google.com/share/ URL. Using redirect: "follow"
    // lands on a DurableDeepLink wrapper page that has no image data.
    let pageUrl = shareUrl;
    if (shareUrl.includes("photos.app.goo.gl")) {
      const redirect = await fetch(shareUrl, {
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      });
      const location = redirect.headers.get("location");
      if (location?.includes("photos.google.com")) {
        pageUrl = location;
      }
    }

    // Step 2: Fetch the actual Google Photos share page
    const res = await fetch(pageUrl, {
      signal: AbortSignal.timeout(8_000),
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return [];

    const html = await res.text();

    // Strategy 1: Extract all googleusercontent.com URLs from the page.
    // These appear in script data, meta tags, and preload links.
    const allGoogleUrls = extractGoogleUserContentUrls(html);
    if (allGoogleUrls.length > 0) return allGoogleUrls;

    // Strategy 2: og:image meta tag (single image fallback)
    const ogMatch = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i);
    if (ogMatch) {
      let imgUrl = ogMatch[1].replace(/&amp;/g, "&");
      if (imgUrl.includes("googleusercontent.com") && !imgUrl.includes("=w")) {
        imgUrl += "=w1200";
      }
      return [imgUrl];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Resolve a Google Photos share link to a single og:image preview URL.
 * The og:image is the preview thumbnail Google explicitly provides for link embedding
 * (used by social media cards, chat previews, etc.) — safer legally than scraping all images.
 */
async function resolveGooglePhotosPreview(shareUrl: string): Promise<string | null> {
  try {
    let pageUrl = shareUrl;
    if (shareUrl.includes("photos.app.goo.gl")) {
      const redirect = await fetch(shareUrl, {
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      });
      const location = redirect.headers.get("location");
      if (location?.includes("photos.google.com")) {
        pageUrl = location;
      }
    }

    const res = await fetch(pageUrl, {
      signal: AbortSignal.timeout(8_000),
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return null;

    const html = await res.text();

    const ogMatch = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i);
    if (ogMatch) {
      let imgUrl = ogMatch[1].replace(/&amp;/g, "&");
      // Replace any existing size suffix with high-quality one
      imgUrl = imgUrl.replace(/=[swh]\d[\da-z-]*$/i, "").replace(/=s\d[\da-z-]*$/i, "");
      return `${imgUrl}=w2048`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract all unique googleusercontent.com image URLs from Google Photos HTML.
 * Google embeds these in various places: AF_initDataCallback script blocks,
 * meta tags, preload links, and inline data.
 */
function extractGoogleUserContentUrls(html: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Match googleusercontent.com URLs — only allow URL-safe characters
  const urlPattern = /https:\/\/lh[3-6]\.googleusercontent\.com\/[a-zA-Z0-9_\-/.=]+/g;
  for (const m of html.matchAll(urlPattern)) {
    // Strip any size/crop suffix: =w600-h315-p-k-no, =s32-p, =w1200, etc.
    const base = m[0].replace(/=[swh]\d[\da-z-]*$/i, "").replace(/=s\d[\da-z-]*$/i, "");
    // Skip avatar/profile-pic paths (/a/ segment)
    if (/\/a\//.test(base)) continue;
    // Skip very short base paths (likely not real photos)
    if (base.length < 80) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    // Request high quality (w2048 is the max Google serves without auth)
    urls.push(`${base}=w2048`);
  }

  return urls;
}

/**
 * Deduplicate photos by extracting a stable key from each URL.
 * Handles Wikimedia URL variants (Special:FilePath vs upload.wikimedia.org).
 */
export function deduplicatePhotos(photos: PlacePhoto[], limit = 20): PlacePhoto[] {
  const seen = new Set<string>();
  const unique: PlacePhoto[] = [];
  for (const p of photos) {
    const key = dedupKey(p.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * Extract a stable dedup key from a photo URL.
 * Wikimedia URLs come in two forms that refer to the same image:
 *   - Special:FilePath/Filename.jpg?width=800
 *   - upload.wikimedia.org/.../thumb/.../800px-Filename.jpg
 * We extract the base filename to catch both.
 */
function dedupKey(url: string): string {
  // Special:FilePath/Filename.jpg?width=800 → filename.jpg
  const filePathMatch = url.match(/Special:FilePath\/([^?]+)/);
  if (filePathMatch) return decodeURIComponent(filePathMatch[1]).toLowerCase();

  // upload.wikimedia.org/.../thumb/a/ab/Filename.jpg/800px-Filename.jpg → filename.jpg
  const uploadMatch = url.match(
    /upload\.wikimedia\.org\/wikipedia\/\w+\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+)/,
  );
  if (uploadMatch) return decodeURIComponent(uploadMatch[1]).toLowerCase();

  // Fallback: normalize generic URL patterns
  return url
    .replace(/\?width=\d+/, "")
    .replace(/\/\d+px-/, "/0px-")
    .replace(/\/thumb\//, "/");
}

export type { PhotoProvider, PhotoQuery } from "./types";
