import type { EnrichmentSource, PlacePhoto } from "@openmapx/core";
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
 * Collect enrichment sources from all integrations registered under the "enrichment" domain.
 * These are tag-based enrichers that produce photos from OSM tags (e.g. wikidata=Q...).
 */
function getTagEnrichers(): EnrichmentSource[] {
  const enrichers: EnrichmentSource[] = [];
  for (const integration of getIntegrationsByDomain("enrichment")) {
    for (const e of (integration.providers.get("enrichment") ?? []) as EnrichmentSource[]) {
      enrichers.push(e);
    }
  }
  return enrichers;
}

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
  const providers = getPhotoProviders();
  const tagEnrichers = getTagEnrichers();

  const totalLimit = query.limit ?? 20;
  const perProvider = Math.max(6, Math.ceil(totalLimit / Math.max(providers.length, 1)));

  // Run coordinate-based providers
  const providerPromises = providers.map((p) => p.search({ ...query, limit: perProvider }));

  // Run tag-based enrichers if OSM tags are available
  const tags = query.osmTags;
  const enricherPromises = tags
    ? tagEnrichers.map((e) => e.enrich(tags).then((r) => r?.photos ?? []))
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
