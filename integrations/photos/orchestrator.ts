import {
  FetchJsonHttpError,
  fetchCommonsMetadata,
  fetchWithRedirects,
  isDisplayablePhoto,
  type PlacePhoto,
  parseId,
  parseRetryAfterMs,
} from "@openmapx/core";
import type { IntegrationContext, LoadedIntegration } from "@openmapx/integration-framework";
import {
  lookupByNameAndCoords,
  lookupByOsmRef,
} from "@openmapx/integration-geocoding/place-lookup";
import type { PhotoProvider, PhotoQuery } from "./types.js";

// Providers in this list are ordered last (street-level imagery — shown after editorial photos)
const DEPRIORITIZED_PROVIDER_IDS = new Set(["mapillary", "panoramax"]);

const OSM_IMAGES_PROVIDER_ID = "osm-images";
interface ImageTagOptions {
  strict?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  onPhotos?: (photos: PlacePhoto[]) => void;
  commons?: {
    getJson: NonNullable<NonNullable<Parameters<typeof fetchCommonsMetadata>[1]>["getJson"]>;
    allowed: () => Promise<boolean>;
  };
}

/** Bound before registration: new Commons requests use only host HTTP/policy. */
export function createOsmImagePhotoProvider(
  ctx: Pick<IntegrationContext, "http" | "getDisallowedSourceIds">,
): PhotoProvider {
  const resolve = async (
    tags: Record<string, string>,
    options?: ImageTagOptions,
  ): Promise<PlacePhoto[]> => {
    if (options?.signal?.aborted) {
      if (options.strict) options.signal.throwIfAborted();
      return [];
    }
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    if (disallowed.has("osm") || disallowed.has("openstreetmap")) return [];
    return extractImageTagPhotos(tags, {
      ...options,
      commons: {
        getJson: (url, httpOptions) => ctx.http.get(url, httpOptions),
        allowed: async () => !disallowed.has("wikimedia-commons") && !disallowed.has("wikimedia"),
      },
    });
  };
  return {
    id: OSM_IMAGES_PROVIDER_ID,
    name: "OSM image references",
    search: (query) =>
      query.osmTags ? resolve(query.osmTags, { signal: query.signal }) : Promise.resolve([]),
    searchByTags: (tags, _limit, options) => resolve(tags, options),
  };
}

/**
 * Collect photo providers from integrations registered under the "photos" domain.
 * Street-level imagery providers (mapillary, panoramax) are sorted to the end.
 */
export function getPhotoProviders(integrations: LoadedIntegration[]): PhotoProvider[] {
  const providers: PhotoProvider[] = [];
  for (const integration of integrations) {
    if (!integration.enabled || !integration.manifest.domains.includes("photos")) continue;
    for (const p of (integration.providers.get("photos") ?? []) as PhotoProvider[]) {
      providers.push(p);
    }
  }
  return providers.sort((a, b) => {
    const aLast = DEPRIORITIZED_PROVIDER_IDS.has(a.id) ? 1 : 0;
    const bLast = DEPRIORITIZED_PROVIDER_IDS.has(b.id) ? 1 : 0;
    return aLast - bLast;
  });
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
export async function searchPhotos(
  query: PhotoQuery,
  providers: PhotoProvider[],
): Promise<PlacePhoto[]> {
  const totalLimit = query.limit ?? 20;
  const perProvider = Math.max(6, Math.ceil(totalLimit / Math.max(providers.length, 1)));

  const results = await Promise.allSettled(
    providers.map((p) => p.search({ ...query, limit: perProvider })),
  );

  // OSM image tags first (highest priority), then provider results
  const all: PlacePhoto[] = [];
  const imageResult =
    results[providers.findIndex((provider) => provider.id === OSM_IMAGES_PROVIDER_ID)];
  if (imageResult?.status === "fulfilled") all.push(...imageResult.value);
  else if (!providers.some((provider) => provider.id === OSM_IMAGES_PROVIDER_ID) && query.osmTags)
    all.push(...(await extractImageTagPhotos(query.osmTags, { signal: query.signal })));
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (providers[index].id !== OSM_IMAGES_PROVIDER_ID && result.status === "fulfilled")
      all.push(...result.value);
  }

  return deduplicatePhotos(all, totalLimit);
}

/**
 * Fast tag-based photo lookup for hero images on place detail pages.
 * Only calls providers that support searchByTags — no geo-search, no coordinate queries.
 * Never throws — individual provider failures are silently dropped.
 */
export async function searchHeroPhotos(
  osmTags: Record<string, string>,
  providers: PhotoProvider[],
  options?: ImageTagOptions,
): Promise<PlacePhoto[]> {
  // Start independent OSM tag and provider work together. Incremental photos
  // let a bounded card request keep a completed source if another stalls.
  const contextual = providers.find((provider) => provider.id === OSM_IMAGES_PROVIDER_ID);
  const imageTask = contextual?.searchByTags
    ? contextual.searchByTags(osmTags, undefined, options)
    : extractImageTagPhotos(osmTags, options);
  const tagPromises: Promise<PlacePhoto[]>[] = [];
  for (const p of providers) {
    if (p.id !== OSM_IMAGES_PROVIDER_ID && p.searchByTags)
      tagPromises.push(
        p.searchByTags(osmTags, undefined, options).then(
          (photos) => {
            options?.onPhotos?.(photos);
            return photos;
          },
          (error) => {
            options?.onError?.(error);
            throw error;
          },
        ),
      );
  }
  const [imageResult, ...results] = await Promise.allSettled([imageTask, ...tagPromises]);

  const all: PlacePhoto[] = imageResult.status === "fulfilled" ? [...imageResult.value] : [];
  if (imageResult.status === "rejected") options?.onError?.(imageResult.reason);
  for (const result of results) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  return deduplicatePhotos(all, 6);
}

/**
 * Extract photos from OSM `image` tags.
 * Handles: `image`, `image:0`, `image:1`, ...
 * Values can be direct URLs, Wikimedia Commons filenames, or Google Photos share links.
 */
async function extractImageTagPhotos(
  tags: Record<string, string>,
  options?: ImageTagOptions,
): Promise<PlacePhoto[]> {
  const photos: PlacePhoto[] = [];
  const seen = new Set<string>();

  // Collect image tag values in order: image, image:0, image:1, ...
  const imageValues: string[] = [];
  if (tags.image) imageValues.push(tags.image);
  for (let i = 0; i <= 20; i++) {
    const v = tags[`image:${i}`];
    if (v) imageValues.push(v);
  }

  // Resolve all values (some may be async, e.g. Google Photos links)
  const resolved = await Promise.allSettled(
    imageValues.map((raw) =>
      resolveImageValue(raw, options).then(
        (urls) => {
          if (urls?.length) {
            options?.onPhotos?.(urls.filter(isDisplayablePhoto));
          }
          return urls;
        },
        (error) => {
          options?.onError?.(error);
          throw error;
        },
      ),
    ),
  );

  for (let i = 0; i < resolved.length; i++) {
    const result = resolved[i];
    if (result.status !== "fulfilled") {
      continue;
    }
    if (!result.value) continue;
    for (const photo of result.value) {
      if (!isDisplayablePhoto(photo) || seen.has(photo.url)) continue;
      seen.add(photo.url);
      photos.push(photo);
    }
  }

  return photos;
}

/**
 * Resolve an OSM image tag value to one or more displayable URLs.
 * Handles direct URLs, Wikimedia Commons filenames, and Google Photos share links.
 */
async function resolveImageValue(
  value: string,
  options?: ImageTagOptions,
): Promise<PlacePhoto[] | null> {
  // Wikimedia Commons filename: "File:Example.jpg"
  if (value.startsWith("File:")) {
    const filename = value.slice(5);
    if (!options?.commons || !(await options.commons.allowed())) return null;
    const metadata = await fetchCommonsMetadata([filename], {
      strict: options.strict,
      signal: options.signal,
      getJson: options.commons.getJson,
    });
    const photo = metadata.get(filename.replace(/_/g, " "));
    return photo ? [photo] : null;
  }

  // Not a URL
  if (!value.startsWith("http://") && !value.startsWith("https://")) return null;

  // Google Photos share link -> resolve og:image preview only.
  // Full album extraction is implemented (extractGoogleUserContentUrls) but
  // disabled for legal reasons (Google ToS, photographer copyright).
  // We only use the og:image which is intended for link-preview embedding.
  if (isGooglePhotosShareUrl(value)) {
    const preview = await resolveGooglePhotosPreview(value, options);
    return preview ? [{ url: preview, source: "google-photos", pageUrl: value }] : null;
  }

  const url = new URL(value);
  const filePath =
    url.hostname === "commons.wikimedia.org"
      ? url.pathname.match(/^\/wiki\/Special:FilePath\/(.+)$/)
      : null;
  const uploaded = ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname)
    ? url.pathname.match(/^\/wikipedia\/commons\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+)/)
    : null;
  const file = filePath?.[1] ?? uploaded?.[1];
  if (file) {
    const filename = decodeURIComponent(file).replace(/_/g, " ");
    if (!options?.commons || !(await options.commons.allowed())) return null;
    const metadata = await fetchCommonsMetadata([filename], {
      strict: options.strict,
      signal: options.signal,
      getJson: options.commons.getJson,
    });
    const photo = metadata.get(filename);
    return photo ? [photo] : null;
  }
  return [{ url: value, source: "osm" }];
}

// Browser-like headers to avoid Google blocking server-side fetches
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const GOOGLE_PHOTOS_SHARE_HOSTS = new Set(["photos.app.goo.gl", "photos.google.com"]);
const GOOGLE_PHOTOS_IMAGE_HOST = /^lh[3-6]\.googleusercontent\.com$/;

function parseHttpsUrl(value: string | URL): URL | null {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (parsed.port !== "" && parsed.port !== "443")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isGooglePhotosShareUrl(value: string | URL): boolean {
  const parsed = parseHttpsUrl(value);
  if (!parsed || !GOOGLE_PHOTOS_SHARE_HOSTS.has(parsed.hostname)) return false;
  if (parsed.hostname === "photos.google.com") return parsed.pathname.startsWith("/share/");
  return parsed.pathname.length > 1;
}

/** The only hosts Google Photos resolution is permitted to return to the proxy. */
export function isGooglePhotosImageUrl(value: string | URL): boolean {
  const parsed = parseHttpsUrl(value);
  return parsed !== null && GOOGLE_PHOTOS_IMAGE_HOST.test(parsed.hostname);
}

async function fetchGooglePhotosSharePage(
  shareUrl: string,
  signal?: AbortSignal,
  strict?: boolean,
): Promise<Response | null> {
  const initial = parseHttpsUrl(shareUrl);
  if (!initial || !isGooglePhotosShareUrl(initial)) return null;
  const response = await fetchWithRedirects(initial, {
    timeoutMs: 8_000,
    signal,
    headers: BROWSER_HEADERS,
    maxRedirects: 3,
    validateRedirectUrl: (next) => isGooglePhotosShareUrl(next),
  });
  if (!response.ok) {
    const error = new FetchJsonHttpError(
      `Google Photos preview HTTP ${response.status}`,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
    if (response.body) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          response.body.cancel(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
      } catch {
        // Keep the upstream HTTP error as the reason for the card outcome.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (strict) throw error;
    return null;
  }
  return response;
}

/**
 * Resolve a Google Photos share link to actual image URLs.
 * Exported so the image proxy can use it as a fallback.
 */
export async function resolveGooglePhotosLink(shareUrl: string): Promise<string[]> {
  try {
    const res = await fetchGooglePhotosSharePage(shareUrl);
    if (!res) return [];

    const html = await res.text();

    // Strategy 1: Extract all googleusercontent.com URLs from the page.
    // These appear in script data, meta tags, and preload links.
    const allGoogleUrls = extractGoogleUserContentUrls(html);
    if (allGoogleUrls.length > 0) return allGoogleUrls;

    // Strategy 2: og:image meta tag (single image fallback)
    const ogMatch = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i);
    if (ogMatch) {
      let imgUrl = ogMatch[1].replace(/&amp;/g, "&");
      if (!isGooglePhotosImageUrl(imgUrl)) return [];
      if (!imgUrl.includes("=w")) {
        imgUrl += "=w1200";
      }
      return isGooglePhotosImageUrl(imgUrl) ? [imgUrl] : [];
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
async function resolveGooglePhotosPreview(
  shareUrl: string,
  options?: { strict?: boolean; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const res = await fetchGooglePhotosSharePage(shareUrl, options?.signal, options?.strict);
    if (!res) return null;

    const html = await res.text();

    const ogMatch = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i);
    if (ogMatch) {
      let imgUrl = ogMatch[1].replace(/&amp;/g, "&");
      if (!isGooglePhotosImageUrl(imgUrl)) return null;
      // Replace any existing size suffix with high-quality one
      imgUrl = imgUrl.replace(/=[swh]\d[\da-z-]*$/i, "").replace(/=s\d[\da-z-]*$/i, "");
      const sized = `${imgUrl}=w2048`;
      return isGooglePhotosImageUrl(sized) ? sized : null;
    }

    return null;
  } catch (error) {
    if (options?.strict) throw error;
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
    if (!isDisplayablePhoto(p)) continue;
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
  // Special:FilePath/Filename.jpg?width=800 -> filename.jpg
  const filePathMatch = url.match(/Special:FilePath\/([^?]+)/);
  if (filePathMatch) return decodeURIComponent(filePathMatch[1]).toLowerCase();

  // upload.wikimedia.org/.../thumb/a/ab/Filename.jpg/800px-Filename.jpg -> filename.jpg
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

/** Resolve OSM tags for a place by ID or coordinates+name. Returns undefined on failure. */
export async function resolveOsmTags(
  placeId: string,
  name: string | undefined,
  lat: number,
  lng: number,
): Promise<Record<string, string> | undefined> {
  try {
    const parsed = parseId(placeId);
    if (parsed?.scheme === "osm") {
      const osmMatch = parsed.value.match(/^(node|way|relation)\/(\d+)/);
      if (osmMatch) {
        const [, osmType, osmId] = osmMatch;
        const place = await lookupByOsmRef(osmType, osmId, placeId);
        return place.osmTags ?? undefined;
      }
    }
    if (name) {
      const place = await lookupByNameAndCoords(name, lat, lng, placeId);
      return place?.osmTags ?? undefined;
    }
  } catch {
    // Tag resolution failed — coordinate-based providers will still work
  }
  return undefined;
}
