import type { Place } from "../../types/place";

/**
 * Keywords matched against rawCategory / category strings from geocoding providers.
 *   MapTiler:          "transit_station", "bus_station", "ferry_terminal", …
 *   Nominatim/Photon:  "railway/station", "highway/bus_stop", "public_transport/platform", …
 */
const CATEGORY_KEYWORDS = [
  "transit",
  "station",
  "stop",
  "terminal",
  "halt",
  "platform",
  "railway",
  "public_transport",
  "ferry",
  "bus",
  "subway",
  "tram",
  "airport",
  "aeroway", // OSM: aeroway/aerodrome, aeroway/terminal
  "aerodrome",
  "funicular",
  "cable_car",
  "gondola",
  "aerialway", // OSM key for cable cars, gondolas, chair lifts
  "monorail",
  "light_rail",
  "train",
] as const;

/**
 * Keywords matched against search-result display names to detect transit places.
 * Multilingual — covers German, French, Spanish, Dutch.
 */
const NAME_KEYWORDS = [
  // English
  "station",
  "bus stop",
  "tram stop",
  "metro",
  "ferry terminal",
  "airport",
  "transit center",
  "train station",
  "rail station",
  "subway",
  "light rail",
  // German
  "haltestelle",
  "bahnhof",
  "bushaltestelle",
  "hauptbahnhof",
  "haltepunkt",
  "u-bahn",
  "s-bahn",
  "straßenbahn",
  "zob", // Zentraler Omnibusbahnhof
  "fähre",
  "flughafen",
  // French
  "gare",
  "arrêt",
  "aéroport",
  "tramway",
  // Spanish
  "estación",
  "parada",
  "aeropuerto",
  "ferrocarril",
  // Italian
  "stazione",
  "fermata",
  "aeroporto",
  // Dutch
  "bushalte",
  "halte",
  "luchthaven",
  "tramhalte",
  // Portuguese
  "estação",
  "paragem",
  // Polish
  "dworzec",
  "przystanek",
  // Czech
  "nádraží",
  "zastávka",
  // Swedish / Norwegian / Danish
  "hållplats",
  "holdeplass",
  "stoppested",
  "flygplats",
  // Japanese (romaji)
  "eki",
] as const;

/** Categories that contain transit keywords but are NOT transit infrastructure. */
const CATEGORY_BLOCKLIST = [
  // "station" false positives
  "charging_station",
  "gas_station",
  "fire_station",
  "police_station",
  "ambulance_station",
  "coastguard_station",
  "lifeboat_station",
  "mountain_rescue_station",
  "power_station",
  "sub_station",
  "substation",
  "pumping_station",
  "weather_station",
  "monitoring_station",
  "radio_station",
  "base_station",
  "recycling_station",
  // "terminal" false positives
  "container_terminal",
  // "train" false positives
  "training",
  // "fuel" is a standalone keyword match
  "fuel",
  // "railway" false positives — infrastructure, not passenger stops
  "signal_box",
  "crossing",
  "level_crossing",
  "rail_yard",
  "workshop",
  "roundhouse",
  "turntable",
  "abandoned",
  "disused",
  "razed",
  "proposed",
  "construction",
] as const;

/** Returns true when rawCategory indicates a transit-infrastructure place. */
export function isTransitRawCategory(rawCategory: string): boolean {
  const lower = rawCategory.toLowerCase();
  if (CATEGORY_BLOCKLIST.some((bl) => lower.includes(bl))) return false;
  return CATEGORY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Returns true when a search-result name looks like a transit stop/station. */
export function isTransitName(name: string): boolean {
  const lower = name.toLowerCase();
  return NAME_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Returns true only when `place` represents actual transit infrastructure and
 * the linked-transit hooks should fire.
 *
 * Both rawCategory (from geocoding providers) and category (from map-click
 * feature properties) are run through the same keyword matcher, so the check
 * is provider-independent and not a hardcoded enum comparison.
 *
 * Decision order:
 *  1. Hard gates: null, coordinate-pin, missing coords/name → false
 *  2. rawCategory present → keyword whitelist
 *  3. category present → same keyword whitelist (handles map-click values like
 *     "station", "bus_stop", "railway" from MapTiler feature properties)
 *  4. Neither present → reject (addresses and other non-transit places)
 */
export function isTransitEligiblePlace(place: Place | null): boolean {
  if (!place) return false;
  if (place.ids?.coordinate !== undefined) return false;
  // Synthetic/opened transit stops are explicitly transit places. The
  // synthetic-stop builder always sets `rawCategory: "transit_stop"` — use
  // that as the canonical marker now that the old `transitStop` scheme is
  // gone and per-provider schemes (tfl, mb, …) vary across providers.
  if (place.rawCategory === "transit_stop") return true;
  if (!place.coordinates || !place.name) return false;
  // External data source places (e.g. EV charging) are never transit infrastructure
  if (place.dataSourceDetail) return false;

  if (place.rawCategory !== undefined) {
    return isTransitRawCategory(place.rawCategory);
  }

  if (place.category !== undefined) {
    return isTransitRawCategory(place.category);
  }

  // No category info at all → reject. Actual transit stops/stations always
  // carry rawCategory from the geocoder or map-click feature properties.
  return false;
}
