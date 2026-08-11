import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BrandDetail } from "../types/brand";

/**
 * Shared query definition for one brand's detail record, so `useBrandDetail`
 * and `useBrandLogos` cannot drift on the query key or staleness policy —
 * which matters here specifically because they need to share a cache entry.
 */
function brandDetailQueryOptions(qid: string | null) {
  return {
    queryKey: ["brand-detail", qid] as const,
    queryFn: () => apiClient.get<BrandDetail>(`${API_ENDPOINTS.brandDetail}/${qid}`),
    staleTime: 24 * 60 * 60 * 1000,
  };
}

/** Full catalog record for the brand header card. */
export function useBrandDetail(qid: string | null) {
  return useQuery<BrandDetail>({
    ...brandDetailQueryOptions(qid),
    enabled: Boolean(qid),
  });
}

/**
 * Logo filenames for a set of distinct brand QIDs, resolved with one hook
 * call regardless of how many QIDs are passed in.
 *
 * A result list can carry any number of distinct brands, and calling
 * `useBrandDetail` once per row would make the hook count track the list
 * length — a rules-of-hooks violation the moment the list changes size.
 * `useQueries` sidesteps that: it is always exactly one hook call here, and
 * each query still shares its cache entry with `useBrandDetail` (same
 * `["brand-detail", qid]` key), so a brand already resolved elsewhere (e.g.
 * the active-brand header) is free.
 */
export function useBrandLogos(qids: string[]): Map<string, string | undefined> {
  const results = useQueries({
    queries: qids.map((qid) => brandDetailQueryOptions(qid)),
  });

  return useMemo(
    () => new Map(qids.map((qid, i) => [qid, results[i]?.data?.logoFile])),
    [qids, results],
  );
}
