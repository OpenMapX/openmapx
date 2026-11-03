"use client";

import {
  type AlongRoutePoi,
  type CategoryPlace,
  type CategorySearchResponse,
  categorySearchQueryOptions,
  type DirectionsQueryParams,
  directionsRequestFor,
  evaluateRouteStopDetours,
  fetchDirections,
  filterRoutePois,
  filterSearchQueryOptions,
  type LngLat,
  prepareRouteMatcher,
  projectRoutePois,
  ROUTE_STOP_CACHE_MS,
  type RouteSearchChunks,
  type RouteStopCandidate,
  type RouteStopDetour,
  routeSearchChunks,
  routeStopAccess,
} from "@openmapx/core";
import {
  type QueryObserverResult,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { RouteSearchQuery } from "./useRouteSearch";

/** Area requests a planning search keeps in flight at once. */
export const PLANNED_SEARCH_CONCURRENCY = 2;
/** A planned trip's corridor does not change while it is being compared. */
const PLANNED_SEARCH_STALE_MS = 300_000;

export interface PlannedRouteSearch {
  /** Results within the corridor, in route order from the start. */
  results: AlongRoutePoi<CategoryPlace>[];
  isSearching: boolean;
  settledChunks: number;
  totalChunks: number;
  /** Areas whose request failed; their stretch of the route has no results. */
  failedChunks: number;
  /** An area answered partially (a provider failed or the area was shrunk). */
  incomplete: boolean;
  /** An area held more matches than it returned. */
  truncated: boolean;
  /** The route is longer than one search covers. */
  capped: boolean;
  searchedMeters: number;
  /** Request the failed areas again. */
  retry: () => void;
}

const NO_CHUNKS: RouteSearchChunks = { chunks: [], totalMeters: 0, searchedMeters: 0 };

type AreaResult = QueryObserverResult<CategorySearchResponse>;

function combineAreas(results: AreaResult[]) {
  return {
    data: results.map((r) => r.data),
    statuses: results.map((r) => r.status),
    refetches: results.map((r) => r.refetch),
  };
}

/** The same array for as long as every element is the same object. */
function useElementwiseStable<T>(values: T[]): T[] {
  const ref = useRef(values);
  if (ref.current.length !== values.length || values.some((v, i) => v !== ref.current[i])) {
    ref.current = values;
  }
  return ref.current;
}

/**
 * Category or chain results along a whole planned route, before navigation
 * starts. The route is searched in consecutive corridor windows (see
 * {@link routeSearchChunks}); a window is requested only while fewer than
 * {@link PLANNED_SEARCH_CONCURRENCY} earlier ones are unanswered, so results
 * arrive from the start of the route onward and one search never floods the
 * place providers. Each window shares the cache of the same area's ordinary
 * category or chain search.
 */
export function usePlannedRouteSearch(
  geometry: LngLat[] | null,
  query: RouteSearchQuery | null,
  lang: string,
): PlannedRouteSearch {
  const plan = useMemo(() => (geometry ? routeSearchChunks(geometry) : NO_CHUNKS), [geometry]);
  const boxes = useMemo(() => plan.chunks.flatMap((chunk) => chunk.boxes), [plan]);
  const category = query?.category ?? null;
  const filter = query?.filter && query.filter.selectors.length > 0 ? query.filter : null;
  const active = category !== null || filter !== null;

  const base = boxes.map((bbox) =>
    filter
      ? filterSearchQueryOptions(filter, bbox, lang)
      : categorySearchQueryOptions(category ?? "", bbox, lang),
  );
  // An area is settled once it has an answer or a final error and nothing is
  // fetching for it; until then it holds one of the in-flight slots. Read from
  // the cache, so a render after any area settles already sees it.
  const client = useQueryClient();
  let unsettled = 0;
  const queries = base.map((options) => {
    const enabled = active && unsettled < PLANNED_SEARCH_CONCURRENCY;
    const state = client.getQueryState(options.queryKey);
    const settled =
      (state?.status === "success" || state?.status === "error") &&
      state.fetchStatus !== "fetching";
    if (!settled) unsettled++;
    return { ...options, enabled, staleTime: PLANNED_SEARCH_STALE_MS };
  });
  const areas = useQueries({ queries, combine: combineAreas });

  const data = useElementwiseStable(areas.data);
  const places = useMemo(() => {
    const byId = new Map<string, CategoryPlace>();
    for (const answer of data) {
      for (const place of answer?.results ?? []) {
        if (!byId.has(place.id)) byId.set(place.id, place);
      }
    }
    return [...byId.values()];
  }, [data]);
  const matcher = useMemo(
    () => (geometry && geometry.length >= 2 ? prepareRouteMatcher(geometry) : null),
    [geometry],
  );
  const results = useMemo(() => {
    if (!active || !matcher) return [];
    return filterRoutePois(projectRoutePois(places, matcher), 0, {
      lookaheadMeters: plan.searchedMeters,
    });
  }, [active, matcher, places, plan.searchedMeters]);

  const settledChunks = active
    ? areas.statuses.filter((status) => status === "success" || status === "error").length
    : 0;
  const failedChunks = active ? areas.statuses.filter((status) => status === "error").length : 0;
  const refetches = areas.refetches;
  const statuses = areas.statuses;
  const retry = useCallback(() => {
    statuses.forEach((status, index) => {
      if (status === "error") void refetches[index]();
    });
  }, [statuses, refetches]);

  return {
    results,
    isSearching: active && settledChunks < boxes.length,
    settledChunks,
    totalChunks: active ? boxes.length : 0,
    failedChunks,
    incomplete: active && data.some((answer) => answer?.partial === true),
    truncated: active && data.some((answer) => answer?.truncated === true),
    capped: plan.searchedMeters < plan.totalMeters,
    searchedMeters: plan.searchedMeters,
    retry,
  };
}

/** Coarse identity of a drawn route, so two alternatives never share a detour. */
function geometryKey(geometry: LngLat[]): string {
  if (geometry.length === 0) return "";
  const mid = geometry[Math.floor(geometry.length / 2)];
  return [geometry.length, geometry[0], mid, geometry[geometry.length - 1]].join("|");
}

export interface PlannedStopDetourInput {
  /** The selected route the candidate was found along. */
  geometry: LngLat[];
  /** The planned itinerary: origin, user stops, destination. */
  waypoints: LngLat[];
  candidate: RouteStopCandidate | null;
  /** The provider that answered the displayed route; requests are pinned to it. */
  provider?: string;
  /** The displayed route's request, without its waypoints. */
  request: Omit<DirectionsQueryParams, "waypoints">;
}

/**
 * Road detour of one selected stop: the planned itinerary with and without it,
 * both requested exactly as the displayed route was. Only the selected
 * candidate is compared, so browsing results costs no routing requests.
 */
export function usePlannedStopDetour({
  geometry,
  waypoints,
  candidate,
  provider,
  request,
}: PlannedStopDetourInput): { detour?: RouteStopDetour; isPending: boolean } {
  const access = candidate ? routeStopAccess(candidate) : null;
  const query = useQuery({
    queryKey: [
      "planned-route-stop-detour",
      provider ?? null,
      request,
      waypoints,
      geometryKey(geometry),
      candidate?.id ?? null,
      access?.coordinates ?? null,
    ],
    queryFn: async ({ signal }) => {
      if (!candidate) return null;
      const [detour] = await evaluateRouteStopDetours({
        route: geometry,
        alongMeters: 0,
        waypoints,
        candidates: [candidate],
        provider,
        signal,
        requestRoute: ({ waypoints: itinerary, provider: pinned, signal: requestSignal }) =>
          fetchDirections(
            { ...directionsRequestFor({ ...request, waypoints: itinerary }), provider: pinned },
            undefined,
            { signal: requestSignal, timeoutMs: 15_000 },
          ),
      });
      return detour ?? null;
    },
    enabled: candidate !== null && waypoints.length >= 2 && geometry.length >= 2,
    staleTime: ROUTE_STOP_CACHE_MS,
    gcTime: ROUTE_STOP_CACHE_MS,
    retry: false,
  });
  return { detour: query.data ?? undefined, isPending: query.isFetching };
}
