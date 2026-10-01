import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { AutocompleteResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";
import { usePrefixPlaceholder } from "./usePrefixPlaceholder";

/**
 * Ranks suggestions near `proximity` (the map centre) higher. The point is
 * rounded to 2 dp (~1 km) and the zoom floored so small pans reuse cached
 * answers, matching the server's cache cells.
 */
export function useAutocomplete(
  query: string,
  lang?: string,
  bias?: { proximity: LngLat; zoom?: number } | null,
) {
  const location: Record<string, string> = {};
  if (bias) {
    location.lat = bias.proximity[1].toFixed(2);
    location.lng = bias.proximity[0].toFixed(2);
    if (bias.zoom !== undefined && Number.isFinite(bias.zoom)) {
      location.zoom = String(Math.floor(bias.zoom));
    }
  }
  const { lat, lng, zoom } = location;
  // Placeholder reuse is keyed on the same location, so suggestions for one
  // place never flash up while the map sits somewhere else.
  const placeholderData = usePrefixPlaceholder<AutocompleteResult[]>(
    "autocomplete",
    query,
    lang,
    lat,
    lng,
    zoom,
  );
  return useQuery<AutocompleteResult[]>({
    queryKey: ["autocomplete", query, lang, lat, lng, zoom],
    queryFn: ({ signal }) =>
      apiClient.get<AutocompleteResult[]>(
        API_ENDPOINTS.autocomplete,
        { q: query, ...(lang && { lang }), ...location },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
    placeholderData,
  });
}
