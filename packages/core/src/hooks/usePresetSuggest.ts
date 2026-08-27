import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { PresetMatch } from "../types/presetMatch";

interface PresetSuggestResponse {
  matches: PresetMatch[];
}

export function usePresetSuggest(query: string, lang?: string) {
  return useQuery({
    queryKey: ["preset-suggest", query, lang],
    queryFn: ({ signal }) =>
      apiClient.get<PresetSuggestResponse>(
        API_ENDPOINTS.presetSuggest,
        { q: query, ...(lang && { lang }) },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
