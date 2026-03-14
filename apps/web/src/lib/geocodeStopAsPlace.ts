import type { LngLat, Place, SearchResult, TransitStop } from "@openmapx/core";
import { API_ENDPOINTS, apiClient, haversineDistance, isTransitRawCategory } from "@openmapx/core";

/** Builds a minimal synthetic Place for a transit stop (used when geocoding finds no match). */
export function makeSyntheticStopPlace(stop: TransitStop): Place {
  return {
    id: `stop:${stop.id}`,
    name: stop.name,
    address: stop.name,
    coordinates: [stop.lng, stop.lat],
  };
}

/**
 * Resolves a transit stop to a Place: tries geocoding first, falls back to a synthetic place.
 * Always returns a Place (never null).
 */
export async function resolveStopAsPlace(stop: TransitStop): Promise<Place> {
  const place = await geocodeStopAsPlace(stop);
  return place ?? makeSyntheticStopPlace(stop);
}

/**
 * Tries to resolve a transit stop to a matching OSM place by geocoding the stop
 * name and finding a result within 500 m whose name overlaps with the stop name.
 * Results with a known non-transit category are excluded.
 *
 * Returns the matched Place or null if no match is found or the request fails.
 */
export async function geocodeStopAsPlace(stop: TransitStop): Promise<Place | null> {
  try {
    const results = await apiClient.get<SearchResult[]>(API_ENDPOINTS.geocode, {
      q: stop.name,
    });
    const stopCoords: LngLat = [stop.lng, stop.lat];
    const match = results.find((r) => {
      if (haversineDistance(r.coordinates, stopCoords) > 500) return false;
      const rName = r.label.toLowerCase();
      const sName = stop.name.toLowerCase();
      if (!rName.includes(sName.slice(0, 12)) && !sName.includes(rName.slice(0, 12))) return false;
      // Reject results with a known category that is not transit-related.
      // Results without a rawCategory (e.g. Pelias, or uncategorised OSM features) are accepted.
      if (r.rawCategory && !isTransitRawCategory(r.rawCategory)) return false;
      return true;
    });
    if (!match) return null;
    return {
      id: match.id,
      name: match.label,
      address: match.label,
      coordinates: match.coordinates,
      category: match.type,
      rawCategory: match.rawCategory,
    };
  } catch {
    return null;
  }
}
