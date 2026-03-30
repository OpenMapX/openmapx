import { wikidataEnricher } from "@integrations/enrichment-wikidata/provider.js";
import { wikipediaEnricher } from "@integrations/enrichment-wikipedia/provider.js";
import { flickrPhotoProvider } from "@integrations/photos-flickr/provider.js";
import { mapillaryPhotoProvider } from "@integrations/photos-mapillary/provider.js";
import { panoramaxPhotoProvider } from "@integrations/photos-panoramax/provider.js";
import { wikimediaGeoProvider } from "@integrations/photos-wikimedia/provider.js";
import type { PlacePhoto } from "@openmapx/core";
import { wikimediaCommonsEnricher } from "../enrichment/wikimedia-commons.enricher";
import type { PhotoProvider, PhotoQuery } from "./types";

/** Coordinate-based photo providers. */
const PROVIDERS: PhotoProvider[] = [
  wikimediaGeoProvider,
  mapillaryPhotoProvider,
  flickrPhotoProvider,
  panoramaxPhotoProvider,
];

/** Tag-based enrichment sources (produce photos from OSM tags like wikidata=Q...). */
const TAG_ENRICHERS = [wikidataEnricher, wikipediaEnricher, wikimediaCommonsEnricher];

/**
 * Queries all photo sources and returns a single merged, deduplicated list.
 *
 * When `osmTags` are provided, tag-based enrichers (Wikidata P18, Wikipedia
 * thumbnail, Wikimedia Commons tag) run alongside the coordinate-based providers.
 * Enrichment photos appear first so the hero image is always at index 0.
 *
 * Never throws — individual provider/enricher failures are silently dropped.
 */
export async function searchPhotos(query: PhotoQuery): Promise<PlacePhoto[]> {
  const totalLimit = query.limit ?? 20;
  const perProvider = Math.max(6, Math.ceil(totalLimit / PROVIDERS.length));

  // Run coordinate-based providers
  const providerPromises = PROVIDERS.map((p) => p.search({ ...query, limit: perProvider }));

  // Run tag-based enrichers if OSM tags are available
  const tags = query.osmTags;
  const enricherPromises = tags
    ? TAG_ENRICHERS.map((e) => e.enrich(tags).then((r) => r?.photos ?? []))
    : [];

  const [enricherResults, providerResults] = await Promise.all([
    Promise.allSettled(enricherPromises),
    Promise.allSettled(providerPromises),
  ]);

  // Enrichment photos first (hero image priority), then provider photos
  const all: PlacePhoto[] = [];
  for (const result of enricherResults) {
    if (result.status === "fulfilled") all.push(...result.value);
  }
  for (const result of providerResults) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  return deduplicatePhotos(all, totalLimit);
}

/**
 * Deduplicate photos by extracting a stable key from each URL.
 * Handles Wikimedia URL variants (Special:FilePath vs upload.wikimedia.org).
 */
function deduplicatePhotos(photos: PlacePhoto[], limit: number): PlacePhoto[] {
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
