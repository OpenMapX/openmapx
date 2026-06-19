import type { CategoryId } from "@integrations/poi-search/types";
import { CATEGORY_DEFINITIONS } from "@integrations/poi-search/types";

/**
 * Maps raw category strings from geocoding providers to internal CategoryId values.
 *
 * Sources:
 * - MapTiler: `properties.categories[0]`  (e.g. "restaurant", "cafe", "gas_station")
 * - Photon:   `properties.osm_value`       (e.g. "restaurant", "supermarket", "fuel")
 * - Nominatim:`r.type`                     (e.g. "restaurant", "pharmacy", "fuel")
 *
 * All values are lowercased + spaces/hyphens → underscores before lookup.
 */
const CATEGORY_TO_ID: Readonly<Record<string, CategoryId>> = {
  // Food & drink
  restaurant: "restaurants",
  food: "restaurants",
  cafe: "cafes",
  coffee: "cafes",
  coffee_shop: "cafes",
  bar: "bars",
  pub: "bars",
  biergarten: "bars",
  nightclub: "nightlife",
  fast_food: "restaurants",
  bakery: "bakeries",
  // Accommodation
  hotel: "hotels",
  motel: "hotels",
  accommodation: "hotels",
  hostel: "hotels",
  guest_house: "hotels",
  // Shopping
  supermarket: "supermarkets",
  grocery: "supermarkets",
  convenience: "supermarkets",
  shopping_mall: "shopping_malls",
  // Health
  hospital: "hospitals",
  clinic: "doctors",
  doctor: "doctors",
  doctors: "doctors",
  dentist: "dentists",
  pharmacy: "pharmacies",
  chemist: "pharmacies",
  // Finance
  bank: "banks",
  atm: "atms",
  // Transport & mobility
  fuel: "fuel",
  gas_station: "fuel",
  petrol: "fuel",
  parking: "parking",
  parking_lot: "parking",
  charging_station: "ev_charging",
  ev_charging: "ev_charging",
  car_repair: "car_repair",
  auto_repair: "car_repair",
  // Education
  school: "schools",
  kindergarten: "kindergartens",
  // Culture & leisure
  museum: "museums",
  cinema: "cinemas",
  movie_theater: "cinemas",
  library: "libraries",
  gym: "gyms",
  fitness_centre: "gyms",
  sports_centre: "gyms",
  swimming_pool: "swimming",
  park: "parks",
  // Emergency services
  police: "police",
  fire_station: "fire_stations",
  ambulance_station: "ambulance_stations",
  // Community
  place_of_worship: "churches",
  church: "churches",
  post_office: "post_offices",
  // Activities
  attraction: "activities",
  tourist_attraction: "activities",
  amusement_park: "activities",
};

/**
 * Generic filter/tune icon (MUI Tune, 24×24 viewBox). Used as the fallback
 * marker icon for ad-hoc NLP filter searches and any other category id that
 * has no entry in CATEGORY_DEFINITIONS.
 */
export const AD_HOC_ICON_PATH =
  "M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z";

/**
 * Resolves a CATEGORY_DEFINITIONS id to its SVG icon path.
 *
 * Returns AD_HOC_ICON_PATH for any id not found in CATEGORY_DEFINITIONS,
 * including the "nlp:filter" sentinel used by ad-hoc filter searches.
 */
export function poiCategoryIconPath(categoryId: string): string {
  return CATEGORY_DEFINITIONS.find((d) => d.id === categoryId)?.iconPath ?? AD_HOC_ICON_PATH;
}

/**
 * SVG `d` paths (24×24 Material Design viewBox) for common POI types not
 * covered by CATEGORY_DEFINITIONS.
 *
 * To add more: go to https://fonts.google.com/icons, find the icon, click
 * "SVG", and copy the `d` attribute from the `<path>` element.
 */
const TRAIN_ICON_PATH =
  "M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-4-.5-8-4m0 2c3.59 0 5.93.48 6.75 1H5.25C6.07 4.48 8.41 4 12 4M7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17m9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5M18 12H6V7h12z";

const MUI_FALLBACK_PATHS: Readonly<Record<string, string>> = {
  // Airport (FlightTakeoff)
  airport: "M2.5 19h19v2h-19zm7.18-1.73L12 18l2.32-.73L21.5 5.5 19 4 12 8 5 4 2.5 5.5z",
  // Train station
  train_station: TRAIN_ICON_PATH,
  railway_station: TRAIN_ICON_PATH,
};

/**
 * Resolves a raw geocoder category string to an SVG icon path.
 *
 * Returns undefined for unknown categories — the caller falls back to the
 * generic icon.
 */
export function resolvePoiIconPath(category: string): string | undefined {
  if (!category) return undefined;

  const normalized = category.trim().toLowerCase().replace(/[\s-]/g, "_");

  const categoryId = CATEGORY_TO_ID[normalized];
  if (categoryId) {
    return CATEGORY_DEFINITIONS.find((d) => d.id === categoryId)?.iconPath;
  }

  return MUI_FALLBACK_PATHS[normalized];
}
