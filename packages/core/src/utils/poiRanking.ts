import type { PoiSearchResult } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import { haversineMeters, normalizeName, normalizePhone, websiteDomain } from "./geo-server";

/** Keep category results bounded consistently with the Overpass result ceiling. */
export const MAX_POI_SEARCH_RESULTS = 50;

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

function isConservativeDuplicate(a: PoiSearchResult, b: PoiSearchResult): boolean {
  if (a.gersId && b.gersId && a.gersId === b.gersId) return true;
  const aName = normalizeName(a.name);
  if (!aName || aName !== normalizeName(b.name)) return false;
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
 * Produces deterministic, map-centred category results and removes only
 * high-confidence within-source duplicates before applying the public cap.
 */
export function rankAndLimitPoiResults(
  results: PoiSearchResult[],
  bbox: BoundingBox,
  limit = MAX_POI_SEARCH_RESULTS,
): PoiSearchResult[] {
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

  const unique: PoiSearchResult[] = [];
  for (const candidate of ranked) {
    if (!unique.some((existing) => isConservativeDuplicate(existing, candidate))) {
      unique.push(candidate);
      if (unique.length === limit) break;
    }
  }
  return unique;
}
