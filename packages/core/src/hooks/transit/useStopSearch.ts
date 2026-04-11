import type { TransitStop } from "@integrations/transit/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { usePrefixPlaceholder } from "../usePrefixPlaceholder";

export function useStopSearch(query: string) {
  const placeholderData = usePrefixPlaceholder<TransitStop[]>("stop-search", query);
  return useQuery({
    queryKey: ["stop-search", query],
    queryFn: () =>
      apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStopSearch, {
        q: query,
        limit: "3",
      }),
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60_000,
    placeholderData,
  });
}
