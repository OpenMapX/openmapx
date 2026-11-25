import { ID_SCHEME_PATTERN, makeId, parseId, withId } from "./identified";
import type { Place, PlaceIds } from "./place";

export { ID_SCHEME_PATTERN, makeId, parseId, withId };

/**
 * Schemes the web client invents for one session: a basemap tile feature, a
 * saved or labelled row, a bare coordinate. They name no upstream record, so
 * they are never stored as a place's id.
 */
export const SESSION_LOCAL_PLACE_ID_SCHEMES = [
  "style-poi",
  "saved",
  "label",
  "coordinate",
] as const;
export type SessionLocalPlaceIdScheme = (typeof SESSION_LOCAL_PLACE_ID_SCHEMES)[number];

/** True when `id` follows the id grammar and names a durable record. */
export function isPersistablePlaceId(id: string): boolean {
  const parsed = parseId(id);
  return (
    parsed !== null &&
    !(SESSION_LOCAL_PLACE_ID_SCHEMES as readonly string[]).includes(parsed.scheme)
  );
}

/** The id to store for a place: its own when durable, otherwise none. */
export function persistablePlaceId(id: string | null | undefined): string | null {
  return id && isPersistablePlaceId(id) ? id : null;
}

/**
 * The key that says whether a place is saved or labelled. A durable place is
 * matched by its id. A session-local place stores no id, so it is matched by
 * position: its coordinate id (`coordinate:<lat>,<lng>` at six decimals), which
 * a stored row without an id yields from its own coordinates. A map click, a
 * basemap POI, and the same place reopened from a list or a label therefore
 * all find the row that was saved for it.
 */
export function savedPlaceKey(place: {
  id: string;
  coordinates: readonly [number, number];
}): string {
  return persistablePlaceId(place.id) ?? `coordinate:${coordinateId(place.coordinates)}`;
}

/** The position a `coordinate:` id names, or null for any other id. */
export function coordinateIdPosition(id: string): { lat: number; lng: number } | null {
  const parsed = parseId(id);
  if (parsed?.scheme !== "coordinate") return null;
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(parsed.value);
  if (!match) return null;
  return { lat: Number(match[1]), lng: Number(match[2]) };
}

/** The {@link savedPlaceKey} of a stored saved or labelled row. */
export function savedRowKey(row: { placeId: string | null; lat: number; lng: number }): string {
  return row.placeId ?? `coordinate:${coordinateId([row.lng, row.lat])}`;
}

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
 * Canonical coordinate-scheme id value, `<lat>,<lng>` at six decimals (the
 * axis order of `geo:` URIs) — shared by the map-click fallback, search bar,
 * street-level card and deep-link handler so the same lat/lng always hashes
 * to the same primary id.
 */
export function coordinateId(coordinates: readonly [number, number]): string {
  const [lng, lat] = coordinates;
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
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
