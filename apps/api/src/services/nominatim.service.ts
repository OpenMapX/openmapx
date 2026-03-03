/**
 * Nominatim geocoding client.
 * Uses the public OSM instance by default; override with NOMINATIM_URL.
 * Rate limit: 1 req/s on the public instance.
 * https://nominatim.org/release-docs/latest/api/Search/
 */

import type { AutocompleteResult, SearchResult } from "@openmapx/core";
import type { GeocodingProvider } from "./geocoding.provider";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const USER_AGENT = "OpenMapX/1.0 (https://github.com/openmapx)";

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

async function fetchNominatim(params: Record<string, string>): Promise<NominatimResult[]> {
  const url = new URL(`${NOMINATIM_URL}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  return res.json() as Promise<NominatimResult[]>;
}

function makeId(r: NominatimResult): string {
  return `${r.osm_type}/${r.osm_id}`;
}

export const nominatimService: GeocodingProvider = {
  async geocode(query: string): Promise<SearchResult[]> {
    const data = await fetchNominatim({ q: query, limit: "10" });
    return data.map((r) => ({
      id: makeId(r),
      label: r.display_name,
      coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
      type: mapType(r.class, r.type),
      confidence: r.importance,
    }));
  },

  async autocomplete(query: string): Promise<AutocompleteResult[]> {
    const data = await fetchNominatim({ q: query, limit: "6", dedupe: "1" });
    return data.map((r) => {
      const short = r.display_name.split(",")[0].trim();
      return {
        id: makeId(r),
        label: short,
        sublabel: r.display_name,
        coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
        type: mapType(r.class, r.type),
      };
    });
  },
};
