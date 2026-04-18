import { formatAddress } from "../geocoding/format-address.js";
import type { GeocodingProviderImpl } from "./types.js";
/**
 * Nominatim geocoding client.
 * Uses the public OSM instance by default; override with NOMINATIM_URL.
 * Rate limit: 1 req/s on the public instance.
 * https://nominatim.org/release-docs/latest/api/Search/
 */

import {
  type AutocompleteResult,
  type ReverseGeocodingResult,
  resolvePoiIconPath,
  type SearchResult,
  USER_AGENT,
} from "@openmapx/core";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";

interface NominatimResult {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  class: string;
  type: string;
  importance: number;
}

function mapType(cls: string, type: string): SearchResult["type"] {
  if (cls === "highway") return "street";
  if (cls === "place" && (type === "house" || type === "building")) return "address";
  if (cls === "amenity" || cls === "shop" || cls === "tourism" || cls === "leisure") return "poi";
  return "region";
}

interface NominatimReverseResult {
  display_name: string;
  name?: string;
  error?: string;
  address?: {
    road?: string;
    house_number?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    county?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
    // POI / landmark categories that Nominatim returns when the matched
    // feature is a named place (Brandenburg Gate, a museum, a park, …).
    // @fragaria/address-formatter understands these aliases and places them
    // correctly per country template.
    attraction?: string;
    tourism?: string;
    historic?: string;
    amenity?: string;
    leisure?: string;
    building?: string;
    shop?: string;
  };
}

async function fetchNominatim(
  params: Record<string, string>,
  lang?: string,
): Promise<NominatimResult[]> {
  const url = new URL(`${NOMINATIM_URL}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": lang ?? "en" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  return res.json() as Promise<NominatimResult[]>;
}

function makeId(r: NominatimResult): string {
  return `osm:${r.osm_type}/${r.osm_id}`;
}

export const nominatimService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    const data = await fetchNominatim({ q: query, limit: "10" }, lang);
    return data.map((r) => ({
      id: makeId(r),
      label: r.display_name,
      coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
      type: mapType(r.class, r.type),
      confidence: r.importance,
      rawCategory: `${r.class}/${r.type}`,
    }));
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const url = new URL(`${NOMINATIM_URL}/reverse`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": lang ?? "en" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimReverseResult;
    if (data.error) return null;

    const a = data.address ?? {};
    const cityName = a.city ?? a.town ?? a.village ?? "";
    const address = formatAddress({
      house_number: a.house_number,
      road: a.road,
      neighbourhood: a.neighbourhood,
      suburb: a.suburb,
      city: a.city,
      town: a.town,
      village: a.village,
      county: a.county,
      state: a.state,
      postcode: a.postcode,
      country: a.country,
      country_code: a.country_code,
      // POI/landmark fields — the formatter slots these into the correct
      // position for each country template (typically before the street).
      attraction: a.attraction,
      tourism: a.tourism,
      historic: a.historic,
      amenity: a.amenity,
      leisure: a.leisure,
      building: a.building,
      shop: a.shop,
    });
    const city = [cityName, a.state ?? a.county ?? ""].filter(Boolean).join(", ");
    return { address, city };
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const data = await fetchNominatim({ q: query, limit: "6", dedupe: "1" }, lang);
    return data.map((r) => {
      const short = r.display_name.split(",")[0].trim();
      return {
        id: makeId(r),
        label: short,
        sublabel: r.display_name,
        coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
        type: mapType(r.class, r.type),
        iconPath: resolvePoiIconPath(r.type),
        rawCategory: `${r.class}/${r.type}`,
      };
    });
  },
};
