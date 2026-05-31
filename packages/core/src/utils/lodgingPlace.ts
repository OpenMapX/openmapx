import type { Place } from "../types/place";

/** OSM `tourism` values that denote a place offering paid lodging. */
const LODGING_TOURISM = new Set([
  "hotel",
  "motel",
  "hostel",
  "guest_house",
  "apartment",
  "chalet",
  "alpine_hut",
  "wilderness_hut",
  "love_hotel",
  "resort",
]);

const LODGING_CATEGORIES = new Set([
  "hotel",
  "motel",
  "hostel",
  "guest house",
  "guesthouse",
  "bed & breakfast",
  "bed and breakfast",
  "apartment",
  "resort",
  "inn",
  "accommodation",
  "lodging",
]);

/**
 * Whether a place offers lodging — gates the hotel prices/booking surface.
 * Checks the OSM `tourism` tag, the resolved category, and the raw category
 * (split into segments so we match whole tokens, never substrings — mirrors the
 * fix in foodPlace.ts). Works for POIs from any geocoding source.
 */
export function isLodging(place: Place): boolean {
  const tourism = place.osmTags?.tourism;
  if (tourism && LODGING_TOURISM.has(tourism)) return true;
  const category = place.category?.toLowerCase();
  if (category && LODGING_CATEGORIES.has(category)) return true;
  const rawSegments = (place.rawCategory?.toLowerCase() ?? "").split(/[/;,\s]+/);
  return rawSegments.some((seg) => LODGING_TOURISM.has(seg));
}
