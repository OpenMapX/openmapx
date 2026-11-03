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
  type Route,
  type RouteSearchChunks,
  type RouteStopCandidate,
  type RouteStopDetour,
  routeSearchChunks,
  routeStopAccess,
} from "@openmapx/core";
import {
  hashKey,
  type QueryObserverResult,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    // Observed so a refetch that starts or ends re-renders and re-runs the gate.
    fetchStatuses: results.map((r) => r.fetchStatus),
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
  // the cache, so a render after any area settles already sees it. Planned
  // areas never refetch on their own (focus, reconnect, remount): that would
  // start every stale area at once.
  const client = useQueryClient();
  const isFetching = (key: readonly unknown[]) =>
    client.getQueryState(key)?.fetchStatus === "fetching";
  let unsettled = 0;
  const queries = base.map((options) => {
    const state = client.getQueryState(options.queryKey);
    const answered = state?.status === "success" || state?.status === "error";
    const settled = answered && !isFetching(options.queryKey);
    // An answered area stays enabled: toggling it back on would refetch it
    // outside the gate (an errored area has no data and is always stale).
    const enabled = active && (answered || unsettled < PLANNED_SEARCH_CONCURRENCY);
    if (!settled) unsettled++;
    return {
      ...options,
      enabled,
      staleTime: PLANNED_SEARCH_STALE_MS,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retryOnMount: false,
    };
  });
  const areas = useQueries({ queries, combine: combineAreas });

  // Retry re-requests failed areas through the same two slots. The queue is a
  // ref so an area leaves it the moment it starts: a render landing between a
  // start and a state update must never start it again.
  const retryQueue = useRef<string[]>([]);
  const [retryTick, setRetryTick] = useState(0);
  const hashes = queries.map((options) => hashKey(options.queryKey));
  const hashSignature = hashes.join("\n");
  const queriesRef = useRef(queries);
  queriesRef.current = queries;
  const refetchesRef = useRef(areas.refetches);
  refetchesRef.current = areas.refetches;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever a fetch starts or ends.
  useEffect(() => {
    if (retryQueue.current.length === 0) return;
    const current = queriesRef.current;
    const indexOf = new Map(current.map((options, index) => [hashKey(options.queryKey), index]));
    const pending = retryQueue.current.filter((hash) => indexOf.has(hash));
    const inFlight = current.filter((options) => isFetching(options.queryKey)).length;
    const start = pending.slice(0, Math.max(0, PLANNED_SEARCH_CONCURRENCY - inFlight));
    retryQueue.current = pending.slice(start.length);
    for (const hash of start) {
      const index = indexOf.get(hash);
      if (index !== undefined) void refetchesRef.current[index]?.();
    }
  }, [retryTick, areas.fetchStatuses, hashSignature]);

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
  const statuses = areas.statuses;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hashes change only with hashSignature.
  const retry = useCallback(() => {
    retryQueue.current = hashes.filter((_, index) => statuses[index] === "error");
    setRetryTick((tick) => tick + 1);
  }, [statuses, hashSignature]);
  const fetching = areas.fetchStatuses.some((status) => status === "fetching");

  return {
    results,
    isSearching:
      active && (settledChunks < boxes.length || fetching || retryQueue.current.length > 0),
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
  /** The displayed route the candidate was found along; stops are compared with it. */
  route: Route;
  /** The planned itinerary: origin, user stops, destination. */
  waypoints: LngLat[];
  candidate: RouteStopCandidate | null;
  /** The provider that answered the displayed route; requests are pinned to it. */
  provider?: string;
  /** The displayed route's request, without its waypoints. */
  request: Omit<DirectionsQueryParams, "waypoints">;
}

/**
 * Road detour of one selected stop: the planned itinerary through it, requested
 * exactly as the displayed route was, compared with that displayed route (the
 * selected alternative, not the provider's fastest). Only the selected
 * candidate is compared, so browsing results costs no routing requests. When
 * the displayed route's provider is unknown, a baseline is requested instead.
 */
export function usePlannedStopDetour({
  route,
  waypoints,
  candidate,
  provider,
  request,
}: PlannedStopDetourInput): { detour?: RouteStopDetour; isPending: boolean } {
  const access = candidate ? routeStopAccess(candidate) : null;
  const geometry = route.geometry;
  const query = useQuery({
    queryKey: [
      "planned-route-stop-detour",
      provider ?? null,
      request,
      waypoints,
      geometryKey(geometry),
      route.duration,
      route.distance,
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
        ...(provider ? { baseline: { route, provider } } : {}),
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
