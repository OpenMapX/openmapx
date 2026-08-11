import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BrandDetail } from "../types/brand";

/** Author + licence for the one Commons logo a brand header card renders at size. */
export interface BrandLogoAttribution {
  author?: string;
  authorUrl?: string;
  license?: string;
  licenseUrl?: string;
}

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

  // `results` is a fresh array identity from `useQueries` on every render
  // (React Query does not stabilize it), so memoizing on `results` directly
  // rebuilds the Map every render even when no query's data actually
  // changed. Memoize on the resolved logo files instead, joined into one
  // string so the memo body only reads values already listed in its
  // dependency array, not `results` itself.
  const logoFilesKey = results.map((r) => r?.data?.logoFile ?? "").join("|");
  return useMemo(() => {
    const logoFiles = logoFilesKey.split("|");
    return new Map(qids.map((qid, i) => [qid, logoFiles[i] || undefined]));
  }, [qids, logoFilesKey]);
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
  return useQuery<BrandLogoAttribution>({
    queryKey: ["brand-logo-attribution", qid] as const,
    queryFn: () =>
      apiClient.get<BrandLogoAttribution>(
        `${API_ENDPOINTS.brandLogoAttribution}/${qid}/logo-attribution`,
      ),
    enabled: Boolean(qid) && hasLogo,
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
}
