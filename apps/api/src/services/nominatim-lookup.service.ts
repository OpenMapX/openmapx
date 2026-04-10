/**
 * Nominatim place detail lookups.
 * Separate from nominatim.service.ts (which handles geocoding/autocomplete)
 * because lookups and reverse-geocode require different endpoints and params.
 */

import { type Place, USER_AGENT } from "@openmapx/core";
import { resolveOsmLabel } from "./osm-label.js";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const DEFAULT_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en",
};

function headersForLang(lang?: string): Record<string, string> {
  if (!lang) return DEFAULT_HEADERS;
  return { ...DEFAULT_HEADERS, "Accept-Language": lang };
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
  postcode?: string;
}

interface NominatimDetailResult {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  class: string;
  type: string;
  address: NominatimAddress;
  extratags?: Record<string, string | undefined>;
}

function buildAddress(addr: NominatimAddress): string {
  const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
  const city = addr.city ?? addr.town ?? addr.village ?? addr.county ?? "";
  const parts = [street, city, addr.postcode, addr.country].filter(Boolean);
  return parts.join(", ");
}

function toPlace(r: NominatimDetailResult, id: string): Place {
  const {
    opening_hours,
    phone,
    website,
    "contact:phone": contactPhone,
    "contact:website": contactWebsite,
    ...rest
  } = r.extratags ?? {};

  const osmTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) osmTags[k] = v;
  }

  const address = buildAddress(r.address) || r.display_name;
  const name = r.display_name.split(",")[0].trim();
  const city = r.address.city ?? r.address.town ?? r.address.village ?? r.address.county;

  return {
    id,
    name,
    address,
    city,
    countryCode: r.address.country_code ?? undefined,
    coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
    category: resolveOsmLabel(r.class, r.type),
    phone: phone ?? contactPhone,
    website: website ?? contactWebsite,
    openingHours: opening_hours,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
}

async function fetchNominatim<T>(url: URL, lang?: string): Promise<T> {
  const res = await fetch(url.toString(), { headers: headersForLang(lang) });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}: ${url.pathname}`);
  return res.json() as Promise<T>;
}

const OSM_TYPE_PREFIX: Record<string, string> = {
  node: "N",
  way: "W",
  relation: "R",
};

/**
 * Fetch place details by OSM type + ID using Nominatim /lookup.
 * e.g. lookupByOsmRef("node", "12345")
 */
export async function lookupByOsmRef(
  osmType: string,
  osmId: string,
  originalId: string,
  lang?: string,
): Promise<Place> {
  const prefix = OSM_TYPE_PREFIX[osmType];
  if (!prefix) throw new Error(`Unknown OSM type: ${osmType}`);

  const url = new URL(`${NOMINATIM_URL}/lookup`);
  url.searchParams.set("osm_ids", `${prefix}${osmId}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");

  // /lookup returns an array; we asked for exactly one ID
  const data = await fetchNominatim<NominatimDetailResult[]>(url, lang);
  if (!data[0]) throw new Error(`Nominatim found no result for ${prefix}${osmId}`);
  return toPlace(data[0], originalId);
}

/** Haversine distance in metres between two lat/lng points. */
function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Reverse-geocode by coordinates to find the nearest OSM element.
 * Returns a Place with address, opening hours, phone, etc. from the closest
 * OSM node/way. Unlike lookupByNameAndCoords, this always succeeds if there's
 * any OSM data near the coordinates — no name matching required.
 */
export async function lookupByCoords(
  lat: number,
  lng: number,
  originalId: string,
  lang?: string,
): Promise<Place | null> {
  const url = new URL(`${NOMINATIM_URL}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("zoom", "18"); // Building-level precision

  try {
    const result = await fetchNominatim<NominatimDetailResult>(url, lang);
    if (!result?.osm_id) return null;
    return toPlace(result, originalId);
  } catch {
    return null;
  }
}

/**
 * Search Nominatim by name within a bounding box around the given coordinates,
 * then return the closest matching result.
 *
 * This is the correct fallback for non-OSM IDs (e.g. MapTiler): a reverse
 * geocode by coordinates alone returns whatever element is geometrically
 * closest, which is often a completely different place. Searching by name
 * + proximity correctly disambiguates "school" from "pitch next door".
 *
 * Returns null if no result is found within MAX_DISTANCE_M metres.
 */
const BBOX_DEGREES = 0.015; // ~1.5 km half-width
const MAX_DISTANCE_M = 500;

// Cache city names by rounded coordinates (~11km grid)
const cityNameCache = new Map<string, { city: string | null; expiresAt: number }>();
const CITY_NAME_TTL_MS = 3_600_000; // 1h

/**
 * Reverse-geocode coordinates to a city name (city-level zoom).
 * Cached aggressively since the same viewport area maps to the same city.
 */
export async function reverseGeocodeCity(
  lat: number,
  lng: number,
  lang?: string,
): Promise<string | null> {
  const effectiveLang = lang ?? "en";
  const key = `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}:${effectiveLang}`;
  const cached = cityNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.city;

  try {
    const url = new URL(`${NOMINATIM_URL}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "10");

    const result = await fetchNominatim<NominatimDetailResult>(url, lang);
    const city = result?.address?.city ?? result?.address?.town ?? result?.address?.village ?? null;

    cityNameCache.set(key, { city, expiresAt: Date.now() + CITY_NAME_TTL_MS });
    return city;
  } catch {
    return null;
  }
}

export async function lookupByNameAndCoords(
  name: string,
  lat: number,
  lng: number,
  originalId: string,
  lang?: string,
): Promise<Place | null> {
  // Nominatim viewbox: left,top,right,bottom = minLng,maxLat,maxLng,minLat
  const viewbox = [
    lng - BBOX_DEGREES,
    lat + BBOX_DEGREES,
    lng + BBOX_DEGREES,
    lat - BBOX_DEGREES,
  ].join(",");

  const url = new URL(`${NOMINATIM_URL}/search`);
  url.searchParams.set("q", name);
  url.searchParams.set("viewbox", viewbox);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", "5");

  const results = await fetchNominatim<NominatimDetailResult[]>(url, lang);
  if (results.length === 0) return null;

  // Pick the result closest to the geocoder's coordinates
  const best = results
    .map((r) => ({
      r,
      dist: distanceMetres(lat, lng, Number.parseFloat(r.lat), Number.parseFloat(r.lon)),
    }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (best.dist > MAX_DISTANCE_M) return null;

  return toPlace(best.r, originalId);
}
