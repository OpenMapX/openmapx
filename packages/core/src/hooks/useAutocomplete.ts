import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { AutocompleteResult } from "../types/search";
import { usePrefixPlaceholder } from "./usePrefixPlaceholder";

export function useAutocomplete(query: string, lang?: string) {
  const placeholderData = usePrefixPlaceholder<AutocompleteResult[]>("autocomplete", query, lang);
  return useQuery({
    queryKey: ["autocomplete", query, lang],
    queryFn: () =>
      apiClient.get<AutocompleteResult[]>(API_ENDPOINTS.autocomplete, {
        q: query,
        ...(lang && { lang }),
      }),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    placeholderData,
  });
}
