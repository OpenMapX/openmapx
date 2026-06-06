import type { Place } from "../types/place";

/**
 * OSM `place=*` values that denote a populated settlement of size "city or
 * smaller" — i.e. the level at which Google Maps shows weather, hotels and
 * neighbourhoods in the place panel. Deliberately excludes `country`, `state`,
 * `region`, `province`, `county`, etc.
 */
const CITY_OR_SMALLER_PLACE = new Set([
  "city",
  "town",
  "village",
  "hamlet",
  "borough",
  "suburb",
  "neighbourhood",
  "quarter",
  "municipality",
]);

/**
 * Lowest `admin_level` we still treat as "city or smaller". OSM convention:
 * 2 = country, 3–5 = state/region/province, 6 = county/city, 7 = town,
 * 8 = municipality/suburb, 9+ = sub-municipal. Cities like Düsseldorf sit at
 * level 6, so 6 is the inclusive threshold.
 */
const MIN_CITY_ADMIN_LEVEL = 6;

/**
 * Whether a place is an administrative area of size "city or smaller" — gates
 * the weather header and the Quick facts / Hotels / Neighborhoods sections.
 *
 * Matches on the OSM `place` tag (settlement classification) or, for entities
 * tagged purely as administrative boundaries, on `admin_level >= 6`. Countries,
 * states and broad regions are excluded, as are ordinary POIs (which carry
 * neither tag).
 */
export function isCityOrSmaller(place: Place): boolean {
  const tags = place.osmTags;
  if (!tags) return false;

  const placeTag = tags.place?.toLowerCase();
  if (placeTag && CITY_OR_SMALLER_PLACE.has(placeTag)) return true;

  if (tags.boundary === "administrative") {
    const level = Number.parseInt(tags.admin_level ?? "", 10);
    if (Number.isFinite(level) && level >= MIN_CITY_ADMIN_LEVEL) return true;
  }

  return false;
}
