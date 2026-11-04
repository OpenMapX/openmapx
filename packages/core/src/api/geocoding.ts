import type { SearchResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";
import { type ApiClient, type ApiRequestOptions, apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface GeocodeParams {
  q: string;
  lang?: string;
  /** Biases results towards a point, rounded to 2 dp (~1 km) like the server cache. */
  proximity?: LngLat | null;
  limit?: number;
}

/** Forward geocoding: the phone's search box and the Android Auto search share it. */
export function fetchGeocode(
  { q, lang, proximity, limit }: GeocodeParams,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<SearchResult[]> {
  return client.get<SearchResult[]>(
    API_ENDPOINTS.geocode,
    {
      q,
      ...(lang && { lang }),
      ...(proximity && { lat: proximity[1].toFixed(2), lng: proximity[0].toFixed(2) }),
      ...(limit !== undefined && { limit: String(limit) }),
    },
    options,
  );
}
