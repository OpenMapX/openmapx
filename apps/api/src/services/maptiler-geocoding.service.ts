/**
 * MapTiler Geocoding API client.
 * Requires MAPTILER_KEY env var.
 * https://docs.maptiler.com/cloud/geocoding/
 */

import type { AutocompleteResult, SearchResult } from "@openmapx/core";
import type { GeocodingProvider } from "./geocoding.provider";

const BASE_URL = "https://api.maptiler.com/geocoding";

interface MaptilerFeature {
  id: string;
  text: string;
  place_name: string;
  place_type: string[];
  relevance: number;
  geometry: { coordinates: [number, number] };
}

interface MaptilerResponse {
  features: MaptilerFeature[];
}

function mapType(placeType: string[]): SearchResult["type"] {
  const t = placeType[0] ?? "";
  if (t === "address") return "address";
  if (t === "poi") return "poi";
  if (t === "street" || t === "neighbourhood") return "street";
  return "region";
}

async function fetchMaptiler(
  query: string,
  params: Record<string, string>,
): Promise<MaptilerResponse> {
  const key = process.env.MAPTILER_KEY;
  if (!key) throw new Error("MAPTILER_KEY env var is required for MapTiler geocoding");

  const url = new URL(`${BASE_URL}/${encodeURIComponent(query)}.json`);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MapTiler geocoding error ${res.status}`);
  return res.json() as Promise<MaptilerResponse>;
}

export const maptilerGeocodingService: GeocodingProvider = {
  async geocode(query: string): Promise<SearchResult[]> {
    const data = await fetchMaptiler(query, { limit: "10" });
    return data.features.map((f) => ({
      id: f.id,
      label: f.place_name,
      coordinates: f.geometry.coordinates,
      type: mapType(f.place_type),
      confidence: f.relevance,
    }));
  },

  async autocomplete(query: string): Promise<AutocompleteResult[]> {
    const data = await fetchMaptiler(query, { limit: "6", autocomplete: "true" });
    return data.features.map((f) => ({
      id: f.id,
      label: f.text,
      sublabel: f.place_name,
      coordinates: f.geometry.coordinates,
      type: mapType(f.place_type),
    }));
  },
};
