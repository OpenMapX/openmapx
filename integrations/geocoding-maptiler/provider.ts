import type { GeocodingProvider as GeocodingProviderImpl } from "@openmapx/integration-geocoding/types";
/**
 * MapTiler Geocoding API client.
 * Requires MAPTILER_KEY env var.
 * https://docs.maptiler.com/cloud/geocoding/
 */

import type {
  AutocompleteResult,
  LngLat,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/core";
import { resolvePoiIconPath } from "@openmapx/core";

const BASE_URL = "https://api.maptiler.com/geocoding";

// MapTiler omits POIs from its default geocoding response, so a query like
// "Köln Hbf" returns only addresses (Düren Hbf, …) and never the station POI.
// Requesting an explicit `types` whitelist that includes `poi` surfaces it
// ("Köln Hauptbahnhof" at relevance 1.0) while keeping addresses, places, and
// admin areas. Every name here is a valid MapTiler feature type — an unknown
// one makes the API return 400.
const SEARCH_TYPES =
  "poi,address,street,neighbourhood,municipality,municipal_district,locality,subregion,region,county,country,postal_code,place";

// Populated by setup(ctx) from the resolved integration config cascade.
let apiKey: string | undefined;
export function setMaptilerApiKey(value: string | undefined): void {
  apiKey = value && value.length > 0 ? value : undefined;
}

interface MaptilerFeature {
  id: string;
  text: string;
  place_name: string;
  place_type: string[];
  relevance: number;
  geometry: { coordinates: [number, number] };
  address?: string;
  context?: Array<{ id: string; text: string }>;
  properties?: { categories?: string[] };
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
  lang?: string,
): Promise<MaptilerResponse> {
  const key = apiKey;
  if (!key)
    throw new Error("MapTiler geocoding requires an API key (config `apiKey` or MAPTILER_KEY)");

  const url = new URL(`${BASE_URL}/${encodeURIComponent(query)}.json`);
  url.searchParams.set("key", key);
  url.searchParams.set("language", lang ?? "en");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`MapTiler geocoding error ${res.status}`);
    return res.json() as Promise<MaptilerResponse>;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMaptilerReverse(
  lng: number,
  lat: number,
  lang?: string,
): Promise<MaptilerResponse> {
  const key = apiKey;
  if (!key)
    throw new Error("MapTiler geocoding requires an API key (config `apiKey` or MAPTILER_KEY)");

  const url = new URL(`${BASE_URL}/${lng},${lat}.json`);
  url.searchParams.set("key", key);
  url.searchParams.set("language", lang ?? "en");
  url.searchParams.set("limit", "1");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`MapTiler reverse geocoding error ${res.status}`);
    return res.json() as Promise<MaptilerResponse>;
  } finally {
    clearTimeout(timer);
  }
}

export const maptilerGeocodingService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]> {
    const params: Record<string, string> = { limit: "10", types: SEARCH_TYPES };
    if (proximity) params.proximity = `${proximity[0]},${proximity[1]}`;
    const data = await fetchMaptiler(query, params, lang);
    return data.features.map((f) => ({
      id: `maptiler:${f.id}`,
      label: f.place_name,
      coordinates: f.geometry.coordinates,
      type: mapType(f.place_type),
      confidence: f.relevance,
      rawCategory: f.properties?.categories?.[0],
    }));
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const data = await fetchMaptilerReverse(lng, lat, lang);
    const feature = data.features[0];
    if (!feature) return null;

    const ctx = feature.context ?? [];
    const cityName =
      ctx.find((c) => c.id.startsWith("municipality") || c.id.startsWith("place"))?.text ?? "";
    const region =
      ctx.find((c) => c.id.startsWith("region") || c.id.startsWith("state"))?.text ?? "";
    return { address: feature.place_name, city: [cityName, region].filter(Boolean).join(", ") };
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const data = await fetchMaptiler(
      query,
      { limit: "6", autocomplete: "true", types: SEARCH_TYPES },
      lang,
    );
    return data.features.map((f) => {
      const category = f.properties?.categories?.[0];
      return {
        id: `maptiler:${f.id}`,
        label: f.text,
        sublabel: f.place_name,
        coordinates: f.geometry.coordinates,
        type: mapType(f.place_type),
        iconPath: category ? resolvePoiIconPath(category) : undefined,
        rawCategory: category,
      };
    });
  },
};
