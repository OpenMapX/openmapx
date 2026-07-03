import { formatAddress, formatStreetLine } from "@openmapx/integration-geocoding/format-address";
import type { GeocodingProvider as GeocodingProviderImpl } from "@openmapx/integration-geocoding/types";
/**
 * Nominatim geocoding client.
 * Uses the public OSM instance by default; override with NOMINATIM_URL.
 * Rate limit: 1 req/s on the public instance.
 * https://nominatim.org/release-docs/latest/api/Search/
 */

import {
  type AutocompleteResult,
  fetchJson,
  type LngLat,
  type ReverseGeocodingResult,
  resolvePoiIconPath,
  type SearchResult,
} from "@openmapx/core";

// Populated by setup(ctx); see setNominatimUrl.
let NOMINATIM_URL = "https://nominatim.openstreetmap.org";

/** Update the Nominatim base URL (called from setup() when service registry resolves it). */
export function setNominatimUrl(url: string): void {
  NOMINATIM_URL = url;
}

interface NominatimResult {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  /** Empty for unnamed address/building features; a POI name otherwise. */
  name?: string;
  class: string;
  type: string;
  importance: number;
  address?: {
    road?: string;
    house_number?: string;
    country_code?: string;
  };
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

  return fetchJson<NominatimResult[]>(url.toString(), {
    timeoutMs: 4_000,
    headers: { "Accept-Language": lang ?? "en" },
    errorMessage: ({ status }) => `Nominatim error ${status}`,
  });
}

function makeId(r: NominatimResult): string {
  return `osm:${r.osm_type}/${r.osm_id}`;
}

export const nominatimService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]> {
    const params: Record<string, string> = { q: query, limit: "10" };
    if (proximity) {
      const [lng, lat] = proximity;
      const d = 0.18;
      // viewbox is x1,y1,x2,y2 = lon1,lat1,lon2,lat2; without `bounded` it only biases.
      params.viewbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
    }
    const data = await fetchNominatim(params, lang);
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

    const data = await fetchJson<NominatimReverseResult>(url.toString(), {
      timeoutMs: 4_000,
      headers: { "Accept-Language": lang ?? "en" },
      nullOnError: true,
    });
    if (data === null) return null;
    if (data.error) return null;

    const a = data.address ?? {};
    const cityName = a.city ?? a.town ?? a.village ?? "";
    const address = formatAddress({
      house_number: a.house_number,
      road: a.road,
      city: a.city,
      town: a.town,
      village: a.village,
      county: a.county,
      state: a.state,
      postcode: a.postcode,
      country: a.country,
      country_code: a.country_code,
    });
    const city = [cityName, a.state ?? a.county ?? ""].filter(Boolean).join(", ");
    return { address, city };
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const data = await fetchNominatim({ q: query, limit: "6", dedupe: "1" }, lang);
    return data.map((r) => {
      // Unnamed address/building features lead display_name with the bare house
      // number in DE/AT/CH, so derive a proper street line ("Kinderhauser
      // Straße 40") instead of splitting off "40".
      const short =
        r.name?.trim() ||
        (r.address && formatStreetLine(r.address)) ||
        r.display_name.split(",")[0].trim();
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
