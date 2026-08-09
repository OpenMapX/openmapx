import type { PoiSearchResult } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import { haversineMeters, normalizeName, normalizePhone, websiteDomain } from "./geo-server";

/**
 * How many results a POI search returns to the client.
 *
 * Deliberately far below the provider fetch ceilings: those bound what we
 * consider, this bounds what we send. Sized so a typical city-level viewport is
 * answered completely rather than sampled — map markers are a single MapLibre
 * symbol layer, so the binding cost is list rendering and payload, not the map.
 */
export const MAX_POI_SEARCH_RESULTS = 200;

function completeness(result: PoiSearchResult): number {
  return [
    result.address,
    result.phone,
    result.email,
    result.website,
    result.brand?.name,
    result.openingHours,
  ].filter(Boolean).length;
}

function hasSharedIdentitySignal(a: PoiSearchResult, b: PoiSearchResult): boolean {
  const aPhone = a.phone ? normalizePhone(a.phone) : "";
  const bPhone = b.phone ? normalizePhone(b.phone) : "";
  if (aPhone && aPhone === bPhone) return true;

  const aDomain = websiteDomain(a.website);
  const bDomain = websiteDomain(b.website);
  if (aDomain && aDomain === bDomain) return true;

  const aAddress = normalizeName(a.address ?? "");
  const bAddress = normalizeName(b.address ?? "");
  if (aAddress && aAddress === bAddress) return true;

  const aBrand = a.brand?.wikidata ?? normalizeName(a.brand?.name ?? "");
  const bBrand = b.brand?.wikidata ?? normalizeName(b.brand?.name ?? "");
  return Boolean(aBrand && aBrand === bBrand);
}

/**
 * Duplicate test for two records already known to share a non-empty normalized
 * name — the name comparison is the caller's job, so it is not repeated here.
 */
function isDuplicateWithinNameBucket(a: PoiSearchResult, b: PoiSearchResult): boolean {
  if (a.category && b.category && a.category !== b.category) return false;

  const distance = haversineMeters(
    a.coordinates[1],
    a.coordinates[0],
    b.coordinates[1],
    b.coordinates[0],
  );
  // Coincident records are duplicates even when sparse. Beyond normal GPS
  // jitter, require an independent contact/address/brand signal so nearby
  // branches of the same chain remain distinct.
  return distance <= 10 || (distance <= 50 && hasSharedIdentitySignal(a, b));
}

/**
 * Drop high-confidence duplicates from an already-ranked list, keeping the
 * earlier (better-ranked) record of each pair.
 *
 * Duplicates require either a shared GERS id or an exact normalized-name match,
 * so indexing on exactly those two keys is exhaustive while avoiding the
 * quadratic all-pairs scan — which matters now that the candidate pool is the
 * full provider fetch ceiling rather than a few dozen records. Each name is
 * normalized once here rather than twice per comparison; a dense chain-store
 * bucket would otherwise repeat that Unicode work thousands of times.
 */
function dedupeRanked(ranked: readonly PoiSearchResult[]): PoiSearchResult[] {
  const unique: PoiSearchResult[] = [];
  const byName = new Map<string, PoiSearchResult[]>();
  const byGers = new Set<string>();

  for (const candidate of ranked) {
    if (candidate.gersId && byGers.has(candidate.gersId)) continue;
    // An unnamed record can never match the name rule, so it is always kept.
    const name = normalizeName(candidate.name);
    const peers = name ? byName.get(name) : undefined;
    if (peers?.some((existing) => isDuplicateWithinNameBucket(existing, candidate))) continue;

    unique.push(candidate);
    if (candidate.gersId) byGers.add(candidate.gersId);
    if (name) {
      if (peers) peers.push(candidate);
      else byName.set(name, [candidate]);
    }
  }
  return unique;
}

/** Which grid row/column a coordinate falls in, clamped to the bbox. */
function cellIndex(value: number, origin: number, span: number, divisions: number): number {
  if (!(span > 0)) return 0;
  const raw = Math.floor(((value - origin) / span) * divisions);
  return Math.min(divisions - 1, Math.max(0, raw));
}

/**
 * Choose `limit` results that cover the bbox rather than crowding into it.
 *
 * The bbox is split into a grid and candidates are taken round-robin across the
 * populated cells, so every occupied part of the viewport contributes a result
 * before any part contributes a second. Straight nearest-first truncation would
 * instead spend the whole budget on the densest corner and leave the rest of the
 * map looking empty. Cells are visited in the order their best-ranked member
 * appears, so the centre of the map still fills first.
 */
function selectSpatiallyEven(
  ranked: readonly PoiSearchResult[],
  bbox: BoundingBox,
  limit: number,
): PoiSearchResult[] {
  const divisions = Math.max(1, Math.ceil(Math.sqrt(limit)));
  const latSpan = bbox.north - bbox.south;
  const lonSpan = bbox.east - bbox.west;

  const cells = new Map<number, PoiSearchResult[]>();
  const cellOrder: number[] = [];
  for (const result of ranked) {
    const row = cellIndex(result.coordinates[1], bbox.south, latSpan, divisions);
    const col = cellIndex(result.coordinates[0], bbox.west, lonSpan, divisions);
    const key = row * divisions + col;
    const bucket = cells.get(key);
    if (bucket) {
      bucket.push(result);
    } else {
      cells.set(key, [result]);
      cellOrder.push(key);
    }
  }

  const picked = new Set<PoiSearchResult>();
  for (let round = 0; picked.size < limit; round++) {
    let placedAny = false;
    for (const key of cellOrder) {
      const bucket = cells.get(key);
      if (!bucket || round >= bucket.length) continue;
      picked.add(bucket[round]);
      placedAny = true;
      if (picked.size === limit) break;
    }
    if (!placedAny) break;
  }

  // Restore rank order — the round-robin only decides membership, not sequence.
  return ranked.filter((result) => picked.has(result));
}

export interface RankedPoiResults {
  results: PoiSearchResult[];
  /** How many distinct results the candidate pool held before the cap. */
  total: number;
  /** True when the cap dropped candidates that the caller had in hand. */
  truncated: boolean;
}

/**
 * Produces deterministic, map-centred category results: removes high-confidence
 * within-source duplicates, then applies the public cap by spatial spread so the
 * capped list still represents the whole viewport. Also reports how many
 * distinct results existed, so callers can say how much was left out.
 */
export function rankPoiResults(
  results: PoiSearchResult[],
  bbox: BoundingBox,
  limit = MAX_POI_SEARCH_RESULTS,
): RankedPoiResults {
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLng = (bbox.west + bbox.east) / 2;
  const ranked = [...results].sort((a, b) => {
    const distanceA = haversineMeters(centerLat, centerLng, a.coordinates[1], a.coordinates[0]);
    const distanceB = haversineMeters(centerLat, centerLng, b.coordinates[1], b.coordinates[0]);
    if (distanceA !== distanceB) return distanceA - distanceB;
    const completenessDelta = completeness(b) - completeness(a);
    if (completenessDelta !== 0) return completenessDelta;
    return a.id.localeCompare(b.id);
  });

  const unique = dedupeRanked(ranked);
  if (unique.length <= limit) {
    return { results: unique, total: unique.length, truncated: false };
  }
  return {
    results: selectSpatiallyEven(unique, bbox, limit),
    total: unique.length,
    truncated: true,
  };
}

/** {@link rankPoiResults} for callers that only need the capped list. */
export function rankAndLimitPoiResults(
  results: PoiSearchResult[],
  bbox: BoundingBox,
  limit = MAX_POI_SEARCH_RESULTS,
): PoiSearchResult[] {
  return rankPoiResults(results, bbox, limit).results;
}
