"use client";

import {
  type AlongRoutePoi,
  type BrandSummary,
  brandToFilter,
  type CategoryId,
  type CategoryPlace,
  fetchDirections,
  type LngLat,
  type OverpassFilter,
  poiAlongRoute,
  prepareRouteMatcher,
  remainingWaypoints,
  routeAheadBounds,
  useCategorySearch,
  useFilterSearch,
  useNavigationStore,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useMemo } from "react";

/** How far ahead along the route to search for POIs. */
const LOOKAHEAD_M = 25_000;
/**
 * Quantize the along-distance that drives the query bounding box. The box only
 * needs to move every few km, so snapping to this step keeps the corridor query
 * cache key stable across the ~1 Hz position fixes — otherwise every fix would
 * issue a fresh Overpass request and hit rate limits.
 */
const BBOX_STEP_M = 5_000;

/**
 * What the "search along route" control lets the user pick: a category (or
 * `preset:<id>` string) or a specific chain.
 */
export type RouteSearchInput = { category: string } | { brand: BrandSummary };

/**
 * What {@link useRouteSearch} actually queries with. Exactly one of the two is
 * ever set — a category is forwarded as-is (resolved server-side); a brand has
 * already been compiled to the `OverpassFilter` that identifies it. Both
 * optional (rather than a discriminated union) so a caller can read
 * `query.filter` straight off the result without narrowing first.
 */
export type RouteSearchQuery = { category?: string; filter?: OverpassFilter };

/**
 * Turns a route-search selection into the query {@link useRouteSearch} consumes.
 * Pure, so this is testable without rendering the map. A brand compiles to the
 * same {@link OverpassFilter} `brandToFilter` produces for the search bar, so a
 * route search and an Explore search for the same chain never disagree; a
 * category passes through unchanged.
 */
export function routeSearchQueryFor(input: RouteSearchInput): RouteSearchQuery {
  if ("brand" in input) return { filter: brandToFilter(input.brand) };
  return { category: input.category };
}

export interface UseRouteSearch {
  results: AlongRoutePoi<CategoryPlace>[];
  isLoading: boolean;
  isError: boolean;
  /** Re-plan the active route through `coord` as a new stop. Resolves to success. */
  addStop: (coord: LngLat) => Promise<boolean>;
}

/**
 * POIs matching a chosen category or brand along the route ahead, plus an
 * `addStop` that re-plans the trip through a selected POI. A category (or
 * `preset:<id>` string, e.g. `preset:amenity/fuel`) is resolved server-side via
 * the Explore category search (`useCategorySearch`); a brand is resolved via
 * the filter search (`useFilterSearch`) the Explore panel already uses for
 * brand results. Both run over the same look-ahead corridor bounding box and
 * share the reroute primitives below.
 */
export function useRouteSearch(query: RouteSearchQuery | null): UseRouteSearch {
  const locale = useLocale();
  const route = useNavigationStore((s) => s.route);
  const alongMeters = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const speedMps = useNavigationStore((s) => s.progress?.speedMps ?? 0);

  // One snap index for the active route, so a results refresh projects the whole
  // POI set — and prunes the waypoints for an added stop — against the same
  // index. A position fix alone never rebuilds it.
  const geometry = route?.geometry;
  const matcher = useMemo(() => (geometry ? prepareRouteMatcher(geometry) : null), [geometry]);

  // Quantize so the query box (and its cache key) only changes every few km,
  // not on every position fix. Results are still filtered against the live
  // position below, so they stay accurate between box refreshes. Shared by
  // both search paths below, so a brand search issues corridor requests at the
  // same cadence a category search does.
  const bboxAlong = Math.floor(alongMeters / BBOX_STEP_M) * BBOX_STEP_M;
  const bbox = useMemo(
    () => (route ? routeAheadBounds(route.geometry, bboxAlong, LOOKAHEAD_M) : null),
    [route, bboxAlong],
  );

  const categoryKey = query?.category ?? null;
  const filter = query?.filter ?? null;

  // Both hooks are always called (never skipped), each gated to a `null`
  // argument — which each hook treats as disabled — by whichever half of
  // `query` isn't active, so hook order stays stable across renders.
  // preset:* keys aren't CategoryIds but the search endpoint resolves them;
  // the hook only forwards the string, so the cast is safe.
  const categorySearch = useCategorySearch(
    categoryKey ? (categoryKey as CategoryId) : null,
    categoryKey ? bbox : null,
    locale,
  );
  const filterSearch = useFilterSearch(filter, filter ? bbox : null, locale);
  const active = filter ? filterSearch : categorySearch;

  const results = useMemo(() => {
    if (!matcher || !active.data?.results) return [];
    return poiAlongRoute(active.data.results, matcher, alongMeters, {
      lookaheadMeters: LOOKAHEAD_M,
      speedMps: speedMps > 0 ? speedMps : undefined,
    });
  }, [matcher, active.data, alongMeters, speedMps]);

  const addStop = async (coord: LngLat): Promise<boolean> => {
    const store = useNavigationStore.getState();
    const { route: r, mode, destinationWaypoints, progress } = store;
    if (!r) return false;
    const from = progress?.snapped ?? destinationWaypoints[0] ?? coord;
    // The store's route wins if a reroute landed since the last render, in which
    // case the memoized index no longer describes it and the geometry is used.
    const tail = remainingWaypoints(
      matcher?.geometry === r.geometry ? matcher : r.geometry,
      destinationWaypoints,
      from,
      progress?.alongMeters ?? 0,
    );
    // Insert the chosen POI just before the final destination.
    const dest = tail[tail.length - 1];
    const waypoints = [...tail.slice(0, -1), coord, dest];

    store.beginReroute();
    const stillNavigating = () => {
      const st = useNavigationStore.getState().status;
      return st !== "idle" && st !== "arrived";
    };
    try {
      const res = await fetchDirections({ waypoints, mode, lang: locale });
      if (!stillNavigating()) return false;
      const next = res.routes?.[res.activeRouteIndex ?? 0];
      if (!next) {
        useNavigationStore.setState({ status: "navigating" });
        useNavigationStore.getState().signalRerouteFailed();
        return false;
      }
      useNavigationStore.getState().addStop(next, waypoints);
      return true;
    } catch {
      if (stillNavigating()) {
        useNavigationStore.setState({ status: "navigating" });
        useNavigationStore.getState().signalRerouteFailed();
      }
      return false;
    }
  };

  return { results, isLoading: active.isLoading, isError: active.isError, addStop };
}
