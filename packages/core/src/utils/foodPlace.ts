import type { Place } from "../types/place";
import { toHttpUrl } from "./httpUrl";

/** OSM `amenity` values that denote a place serving food/drink to order. */
const FOOD_AMENITIES = new Set([
  "restaurant",
  "fast_food",
  "cafe",
  "bar",
  "pub",
  "biergarten",
  "ice_cream",
  "food_court",
]);

/** Lowercased category labels that denote a food/drink place. */
const FOOD_CATEGORIES = new Set([
  "restaurant",
  "cafe",
  "café",
  "coffee shop",
  "bar",
  "pub",
  "fast food",
  "fast_food",
  "bakery",
  "ice cream",
  "biergarten",
  "food court",
]);

/**
 * Whether a place serves food/drink — gates the Menu + delivery rows. Checks
 * OSM `amenity`, the presence of a `cuisine` tag, and the resolved category /
 * raw category so it works for POIs from any source.
 */
export function isFoodPlace(place: Place): boolean {
  const amenity = place.osmTags?.amenity;
  if (amenity && FOOD_AMENITIES.has(amenity)) return true;
  if (place.osmTags?.cuisine) return true;
  const category = place.category?.toLowerCase();
  if (category && FOOD_CATEGORIES.has(category)) return true;
  // rawCategory is provider-specific, usually `<key>/<value>` (e.g.
  // "amenity/restaurant"). Match whole `/`-, `;`-, `,`- or space-delimited
  // segments — NOT substrings — so short amenity tokens like "bar"/"pub" don't
  // misclassify "barber"/"public_building" as food places.
  const rawSegments = (place.rawCategory?.toLowerCase() ?? "").split(/[/;,\s]+/);
  return rawSegments.some((seg) => FOOD_AMENITIES.has(seg));
}

/**
 * The explicit menu URL from OSM tags (`website:menu`, then `menu:url`,
 * `url:menu`), normalised to an absolute http(s) URL. Null when no such tag.
 */
export function resolveOsmMenuUrl(place: Place): string | null {
  const raw =
    place.osmTags?.["website:menu"] ?? place.osmTags?.["menu:url"] ?? place.osmTags?.["url:menu"];
  return raw ? toHttpUrl(raw) : null;
}
