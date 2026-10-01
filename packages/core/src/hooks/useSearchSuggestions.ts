import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";
import type { SearchSuggestionsResponse } from "../types/searchSuggestion";
import { isUppercaseAcronymIntent, normalizeSearchTerm } from "../utils/searchSuggestion";

function roundedCoordinate(value: number): string {
  return value.toFixed(2);
}

export function useSearchSuggestions(
  query: string,
  lang: string,
  proximity: LngLat | null | undefined,
  limit = 8,
) {
  const normalizedQuery = normalizeSearchTerm(query);
  const searchableLength = normalizedQuery.replace(/[^\p{L}\p{N}]/gu, "").length;
  const roundedProximity = proximity
    ? ([Number(roundedCoordinate(proximity[0])), Number(roundedCoordinate(proximity[1]))] as LngLat)
    : null;

  // The server answers uppercase input with generated acronyms too ("BER"),
  // so the case of the text is part of what the answer depends on.
  const acronymIntent = isUppercaseAcronymIntent(query);

  return useQuery<SearchSuggestionsResponse>({
    queryKey: ["search-suggestions", normalizedQuery, acronymIntent, lang, roundedProximity, limit],
    queryFn: ({ signal }) =>
      apiClient.get<SearchSuggestionsResponse>(
        API_ENDPOINTS.searchSuggestions,
        {
          q: query.trim(),
          lang,
          ...(roundedProximity && {
            lng: roundedCoordinate(roundedProximity[0]),
            lat: roundedCoordinate(roundedProximity[1]),
          }),
          limit: String(limit),
        },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: searchableLength >= 2,
    staleTime: 5 * 60_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
    placeholderData: keepPreviousData,
  });
}
