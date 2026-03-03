/**
 * Nominatim place detail lookups for Phase 4.
 * Separate from nominatim.service.ts (which handles geocoding/autocomplete)
 * because lookups and reverse-geocode require different endpoints and params.
 */

import type { Place } from "@openmapx/core";
import { resolveOsmLabel } from "./osm-label.js";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  "Accept-Language": "en",
};

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
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
  const { opening_hours, phone, website, ...rest } = r.extratags ?? {};

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
    coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
    category: resolveOsmLabel(r.class, r.type),
    phone,
    website,
    openingHours: opening_hours,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
}

async function fetchNominatim<T>(url: URL): Promise<T> {
  const res = await fetch(url.toString(), { headers: HEADERS });
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
): Promise<Place> {
  const prefix = OSM_TYPE_PREFIX[osmType];
  if (!prefix) throw new Error(`Unknown OSM type: ${osmType}`);

  const url = new URL(`${NOMINATIM_URL}/lookup`);
  url.searchParams.set("osm_ids", `${prefix}${osmId}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");

  // /lookup returns an array; we asked for exactly one ID
  const data = await fetchNominatim<NominatimDetailResult[]>(url);
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

export async function lookupByNameAndCoords(
  name: string,
  lat: number,
  lng: number,
  originalId: string,
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

  const results = await fetchNominatim<NominatimDetailResult[]>(url);
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
