import { makeId, parseId, withId } from "./identified";
import type { Place, PlaceIds } from "./place";

export { makeId, parseId, withId };

/**
 * Build a `Place` with its primary `id` computed from `primaryScheme` +
 * `ids`. Every producer (geocoders, transit, data sources, categories, …)
 * should use this helper rather than setting `id` by hand so the
 * derivation stays consistent and centralized.
 */
export function createPlace(place: Omit<Place, "id">): Place {
  return withId<Place>(place);
}

/**
 * Canonical coordinate-scheme id value — shared by the map-click fallback,
 * search bar, and deep-link handler so the same lat/lng always hashes to
 * the same primary id.
 */
export function coordinateId(coordinates: readonly [number, number]): string {
  const [lng, lat] = coordinates;
  return `${lat.toFixed(6)}-${lng.toFixed(6)}`;
}

/**
 * Round-trip a canonical primary-id string (from a saved-places row, a
 * deep-link URL, or a route parameter) back into an identity pair suitable
 * for passing into {@link createPlace}. Returns `null` when the input
 * can't be parsed so callers can substitute a fallback.
 */
export function idsFromPrimary(
  primary: string | undefined | null,
): { primaryScheme: string; ids: PlaceIds } | null {
  const parsed = parseId(primary);
  if (!parsed) return null;
  return { primaryScheme: parsed.scheme, ids: { [parsed.scheme]: parsed.value } };
}

/**
 * Like {@link idsFromPrimary} but falls back to a coordinate-scheme id
 * when the input doesn't parse. Use from handlers that accept opaque
 * upstream ids (geocoder results, deep links) but always have coordinates
 * on hand.
 */
export function idsFromPrimaryOrCoords(
  primary: string | undefined | null,
  coordinates: readonly [number, number],
): { primaryScheme: string; ids: PlaceIds } {
  return (
    idsFromPrimary(primary) ?? {
      primaryScheme: "coordinate",
      ids: { coordinate: coordinateId(coordinates) },
    }
  );
}
