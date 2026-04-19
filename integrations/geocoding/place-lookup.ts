/**
 * Nominatim place detail lookups.
 * Separate from nominatim geocoding (which handles geocoding/autocomplete)
 * because lookups and reverse-geocode require different endpoints and params.
 */

import {
  createPlace,
  type OsmFilter,
  type OverpassNode,
  type OverpassWay,
  overpassQuery,
  type Place,
  type PlaceIds,
  parseId,
  USER_AGENT,
} from "@openmapx/core";
import { formatAddress } from "./format-address.js";
import { resolveOsmLabel } from "./osm-label.js";

function buildIds(result: NominatimDetailResult, requestId: string): PlaceIds {
  const osmRef = `${result.osm_type}/${result.osm_id}`;
  const ids: PlaceIds = { osm: osmRef };
  // Carry any non-OSM scheme from the request forward — e.g. a `dataSource:`
  // item that maps to an OSM node still needs its original identity for
  // client-side dispatch (filter lookup, reviews, saved-places, etc.).
  const parsed = parseId(requestId);
  if (parsed && parsed.scheme !== "osm" && !ids[parsed.scheme]) {
    ids[parsed.scheme] = parsed.value;
  }
  return ids;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export function setPlaceLookupNominatimUrl(value: string | undefined): void {
  NOMINATIM_URL = value && value.length > 0 ? value : "https://nominatim.openstreetmap.org";
}

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

  const address = formatAddress(r.address) || r.display_name;
  const name = r.display_name.split(",")[0].trim();
  const city = r.address.city ?? r.address.town ?? r.address.village ?? r.address.county;

  return createPlace({
    primaryScheme: "osm",
    ids: buildIds(r, id),
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
  });
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
 * any OSM data near the coordinates -- no name matching required.
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

/**
 * Reverse-geocode coordinates to a structured street address (zoom=18, building level).
 * Returns only the address string and city — no POI name, phone, or business details.
 *
 * When Nominatim finds the road but no house number (common for sidewalk/corner locations),
 * falls back to an Overpass query for the nearest addr:housenumber node on that street
 * within 50 m — where the actual mapped building addresses are.
 */
export async function lookupAddressByCoords(
  lat: number,
  lng: number,
): Promise<{ address: string; city?: string } | null> {
  const url = new URL(`${NOMINATIM_URL}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");

  let addr: NominatimAddress | undefined;

  try {
    const result = await fetchNominatim<NominatimDetailResult>(url);
    if (!result?.osm_id) return null;
    addr = result.address;
  } catch {
    return null;
  }

  if (!addr?.road) return null;

  const city = addr.city ?? addr.town ?? addr.village ?? addr.county;

  // If Nominatim didn't return a house number, search for the nearest
  // address on the same street via a structured Nominatim query (50 m radius).
  const houseNumber =
    addr.house_number ?? (await lookupNearestHouseNumber(lat, lng, addr.road, 50));

  return {
    address: formatAddress({ ...addr, house_number: houseNumber }),
    city,
  };
}

/**
 * Query Overpass for the nearest node/way with addr:housenumber + addr:street
 * matching the given road name, within radiusM metres of [lat, lng].
 */
async function lookupNearestHouseNumber(
  lat: number,
  lng: number,
  road: string,
  radiusM: number,
): Promise<string | undefined> {
  const escapedRoad = road.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `[out:json][timeout:5];(node["addr:housenumber"]["addr:street"="${escapedRoad}"](around:${radiusM},${lat},${lng});way["addr:housenumber"]["addr:street"="${escapedRoad}"](around:${radiusM},${lat},${lng}););out center 5;`;

  try {
    const data = await overpassQuery(query);
    if (!data.elements.length) return undefined;

    const best = data.elements
      .filter((el): el is OverpassNode | OverpassWay => el.type === "node" || el.type === "way")
      .map((el) => {
        let elLat: number;
        let elLon: number;
        if (el.type === "node") {
          elLat = el.lat;
          elLon = el.lon;
        } else if (el.center) {
          elLat = el.center.lat;
          elLon = el.center.lon;
        } else {
          return null;
        }
        return {
          hn: el.tags?.["addr:housenumber"],
          dist: distanceMetres(lat, lng, elLat, elLon),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && !!c.hn)
      .sort((a, b) => a.dist - b.dist)[0];

    return best?.hn;
  } catch {
    return undefined;
  }
}

const OVERPASS_BBOX_DEG = 0.002; // ~220 m half-width — tight enough to avoid neighbouring stations
const OVERPASS_MAX_DISTANCE_M = 150;

/**
 * Find the OSM element nearest to [lat, lng] that matches one of the given
 * tag filters, using Overpass. Returns null if nothing is found within
 * OVERPASS_MAX_DISTANCE_M metres or if Overpass is unavailable.
 *
 * Used to enrich data-source items (fuel, EV, bike sharing, parking, car sharing)
 * with the correct OSM node/way rather than a plain reverse geocode which returns
 * whatever element is geometrically closest regardless of type.
 */
export async function lookupByOsmFilters(
  lat: number,
  lng: number,
  filters: OsmFilter[],
  originalId: string,
): Promise<Place | null> {
  const bboxStr = `${lat - OVERPASS_BBOX_DEG},${lng - OVERPASS_BBOX_DEG},${lat + OVERPASS_BBOX_DEG},${lng + OVERPASS_BBOX_DEG}`;

  const escapeOql = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = filters
    .flatMap((f) => [
      `node["${escapeOql(f.key)}"="${escapeOql(f.value)}"](${bboxStr});`,
      `way["${escapeOql(f.key)}"="${escapeOql(f.value)}"](${bboxStr});`,
    ])
    .join("\n  ");
  const query = `[out:json][timeout:10];\n(\n  ${lines}\n);\nout center 10;`;

  try {
    const data = await overpassQuery(query);
    if (!data.elements.length) return null;

    const candidates = data.elements
      .filter((el): el is OverpassNode | OverpassWay => el.type === "node" || el.type === "way")
      .map((el) => {
        let elLat: number;
        let elLon: number;
        if (el.type === "node") {
          elLat = el.lat;
          elLon = el.lon;
        } else if (el.center) {
          elLat = el.center.lat;
          elLon = el.center.lon;
        } else {
          return null;
        }
        return { el, elLat, elLon, dist: distanceMetres(lat, lng, elLat, elLon) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.dist - b.dist);

    const best = candidates[0];
    if (!best || best.dist > OVERPASS_MAX_DISTANCE_M) return null;

    return overpassElementToPlace(best.el, best.elLat, best.elLon, originalId);
  } catch {
    return null;
  }
}

function overpassElementToPlace(
  el: OverpassNode | OverpassWay,
  lat: number,
  lng: number,
  originalId: string,
): Place | null {
  const tags = el.tags ?? {};
  const name = tags.name ?? "";
  const housenumber = tags["addr:housenumber"];
  const street = tags["addr:street"];
  const phone = tags.phone ?? tags["contact:phone"];
  const website = tags.website ?? tags["contact:website"];
  const openingHours = tags.opening_hours;

  const city = tags["addr:city"] ?? tags["addr:town"] ?? undefined;
  const countryCode = tags["addr:country"]?.toLowerCase() ?? undefined;
  // Address from structured addr:* tags only — don't fall back to the element name
  // because data source items use selectedPlace.name for identity already.
  const address = formatAddress(
    { road: street, house_number: housenumber, country_code: countryCode },
    { appendCountry: false },
  );

  const osmTags: Record<string, string> = { ...tags };

  const osmRef = `${el.type}/${el.id}`;
  const ids: PlaceIds = { osm: osmRef };
  const parsed = parseId(originalId);
  if (parsed && parsed.scheme !== "osm" && !ids[parsed.scheme]) {
    ids[parsed.scheme] = parsed.value;
  }

  return createPlace({
    primaryScheme: "osm",
    ids,
    name,
    address,
    city,
    countryCode,
    coordinates: [lng, lat],
    phone,
    website,
    openingHours,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  });
}
