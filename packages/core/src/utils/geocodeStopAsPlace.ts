import type { TransitStop } from "@openmapx/mobility-core/transit";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { isTransitRawCategory } from "../hooks/transit/transitEligibility";
import type { SearchResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";
import { parseId } from "../types/identified";
import type { Place, PlaceIds } from "../types/place";
import { createPlace } from "../types/placeIds";
import { haversineDistance } from "./coordinates";

/**
 * Collect every identifier a transit stop carries — its explicit `ids`
 * map when the producer populated one, plus the primary scheme/value
 * derived from the canonical `scheme:value` id string. Transit providers
 * namespace their stop ids in that form (see `integrations/transit-*`),
 * so parsing `stop.id` is the natural fallback when no map is present.
 */
function collectStopIdentity(stop: TransitStop): {
  primaryScheme: string;
  ids: PlaceIds;
} {
  const parsed = parseId(stop.id);
  const primaryScheme = stop.primaryScheme ?? parsed?.scheme ?? stop.provider;
  const ids: PlaceIds = { ...(stop.ids ?? {}) };
  if (parsed && !ids[parsed.scheme]) ids[parsed.scheme] = parsed.value;
  if (!ids[primaryScheme]) {
    ids[primaryScheme] = parsed?.value ?? stop.id;
  }
  return { primaryScheme, ids };
}

/** Builds a minimal synthetic Place for a transit stop (used when geocoding finds no match). */
export function makeSyntheticStopPlace(stop: TransitStop): Place {
  const { primaryScheme, ids } = collectStopIdentity(stop);
  return createPlace({
    primaryScheme,
    ids,
    name: stop.name,
    address: stop.name,
    coordinates: [stop.lng, stop.lat],
    category: "station",
    rawCategory: "transit_stop",
  });
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
    // When the geocoder matches an OSM feature, promote `osm` to primary —
    // either way we keep every known id from the stop so downstream panels
    // can dispatch to the transit provider even after matching OSM.
    const stopIdentity = collectStopIdentity(stop);
    const ids: PlaceIds = { ...stopIdentity.ids };
    let primaryScheme = stopIdentity.primaryScheme;
    const osmParsed = parseId(match.id);
    if (osmParsed?.scheme === "osm") {
      ids.osm = osmParsed.value;
      primaryScheme = "osm";
    }
    return createPlace({
      primaryScheme,
      ids,
      name: match.label,
      address: match.label,
      coordinates: match.coordinates,
      category: match.type ?? "station",
      // Always mark the Place as a transit stop, even when the geocoder
      // reported a more specific rawCategory — downstream UI uses this
      // marker to decide whether to render the stop panel, and every
      // Place reaching this function came through an explicit transit-stop
      // click/search flow.
      rawCategory: "transit_stop",
    });
  } catch {
    return null;
  }
}
