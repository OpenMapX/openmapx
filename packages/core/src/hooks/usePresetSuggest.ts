import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { PresetMatch } from "../types/presetMatch";

interface PresetSuggestResponse {
  matches: PresetMatch[];
}

export function usePresetSuggest(query: string, lang?: string) {
  return useQuery({
    queryKey: ["preset-suggest", query, lang],
    queryFn: () =>
      apiClient.get<PresetSuggestResponse>(API_ENDPOINTS.presetSuggest, {
        q: query,
        ...(lang && { lang }),
      }),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}
