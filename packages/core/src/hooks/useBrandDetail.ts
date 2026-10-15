import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BrandDetail } from "../types/brand";
import type { PlacePhoto } from "../types/place";
import { isDisplayablePhoto } from "../utils/commons-metadata";

/** Author + licence for the one Commons logo a brand header card renders at size. */
export interface BrandLogoAttribution extends PlacePhoto {
  logoFile: string;
}

/**
 * Shared query definition for one brand's detail record, so `useBrandDetail`
 * and `useBrandLogos` cannot drift on the query key or staleness policy —
 * which matters here specifically because they need to share a cache entry.
 */
function brandDetailQueryOptions(qid: string | null) {
  return {
    queryKey: ["brand-detail-v2", qid] as const,
    queryFn: () =>
      apiClient.get<BrandDetail>(`${API_ENDPOINTS.brandDetail}/${qid}`, { catalogue: "2" }),
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
 * Captured catalogue records for a set of distinct brand QIDs, resolved with one hook
 * call regardless of how many QIDs are passed in.
 *
 * A result list can carry any number of distinct brands, and calling
 * `useBrandDetail` once per row would make the hook count track the list
 * length — a rules-of-hooks violation the moment the list changes size.
 * `useQueries` sidesteps that: it is always exactly one hook call here, and
 * each query still shares its cache entry with `useBrandDetail` (same
 * `["brand-detail-v2", qid]` key), so a brand already resolved elsewhere (e.g.
 * the active-brand header) is free.
 */
export function useBrandLogos(qids: string[]): Map<string, BrandDetail | undefined> {
  const results = useQueries({ queries: qids.map((qid) => brandDetailQueryOptions(qid)) });
  const stable = useRef<{
    qids: string[];
    data: Array<BrandDetail | undefined>;
    map: Map<string, BrandDetail | undefined>;
  }>({ qids: [], data: [], map: new Map() });
  const data = results.map((result) => result.data);
  if (
    qids.length !== stable.current.qids.length ||
    qids.some(
      (qid, index) =>
        qid !== stable.current.qids[index] || data[index] !== stable.current.data[index],
    )
  ) {
    stable.current = {
      qids: [...qids],
      data,
      map: new Map(qids.map((qid, index) => [qid, data[index]])),
    };
  }
  return stable.current.map;
}

/**
 * Author + licence for one brand's displayed Commons logo, resolved lazily
 * and non-blocking: the caller (the brand header card) paints name and
 * description immediately from the store, and this fills in attribution
 * once it resolves. Degrades silently — `enabled: false` when there's no
 * logo to attribute, and the query itself never throws into the UI since
 * callers only read `data`, never `error`.
 */
export function useBrandLogoAttribution(qid: string | null, hasLogo: boolean) {
  return useQuery<BrandLogoAttribution, Error, BrandLogoAttribution | undefined>({
    queryKey: ["brand-logo-attribution-v3", qid] as const,
    queryFn: () =>
      apiClient.get<BrandLogoAttribution>(
        `${API_ENDPOINTS.brandLogoAttribution}/${qid}/logo-attribution`,
        { fileMetadata: "3" },
      ),
    enabled: Boolean(qid) && hasLogo,
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
    select: (photo) => (isDisplayablePhoto(photo) ? photo : undefined),
  });
}
