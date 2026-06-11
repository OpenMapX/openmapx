import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BoundingBox } from "../types/geometry";
import type { SearchIntent } from "../types/search";

export interface NlpParseResponse {
  intent: SearchIntent;
  resolvedBbox: BoundingBox;
  provider: "local" | "claude" | "openai" | "keyword";
  cached: boolean;
}

export function useNlpSearch(
  query: string,
  mapCenter: [number, number] | null,
  mapBbox: BoundingBox | null,
  enabled: boolean,
  lang?: string,
  noCloud?: boolean,
) {
  const centerKey = mapCenter ? `${mapCenter[0].toFixed(2)},${mapCenter[1].toFixed(2)}` : null;

  return useQuery<NlpParseResponse>({
    queryKey: ["nlp-search", query, lang, centerKey, noCloud ?? false],
    queryFn: () =>
      apiClient.post<NlpParseResponse>(API_ENDPOINTS.nlpParse, {
        query,
        mapCenter,
        mapBbox,
        lang,
        ...(noCloud ? { noCloud: true } : {}),
      }),
    enabled: enabled && query.trim().length >= 4 && !!mapCenter && !!mapBbox,
    staleTime: 60_000,
    gcTime: 600_000,
  });
}
