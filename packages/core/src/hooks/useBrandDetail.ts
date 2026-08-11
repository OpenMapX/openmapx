import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BrandDetail } from "../types/brand";

/** Full catalog record for the brand header card. */
export function useBrandDetail(qid: string | null) {
  return useQuery<BrandDetail>({
    queryKey: ["brand-detail", qid],
    queryFn: () => apiClient.get<BrandDetail>(`${API_ENDPOINTS.brandDetail}/${qid}`),
    enabled: Boolean(qid),
    staleTime: 24 * 60 * 60 * 1000,
  });
}
