"use client";

import {
  type AlongRoutePoi,
  type CategoryId,
  type CategoryPlace,
  fetchDirections,
  type LngLat,
  poiAlongRoute,
  prepareRouteMatcher,
  remainingWaypoints,
  routeAheadBounds,
  useCategorySearch,
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

export interface UseRouteSearch {
  results: AlongRoutePoi<CategoryPlace>[];
  isLoading: boolean;
  isError: boolean;
  /** Re-plan the active route through `coord` as a new stop. Resolves to success. */
  addStop: (coord: LngLat) => Promise<boolean>;
}

/**
 * POIs of a chosen category along the route ahead, plus an `addStop` that
 * re-plans the trip through a selected POI. Reuses the Explore category search
 * (`useCategorySearch`) over a look-ahead corridor bounding box and the shared
 * reroute primitives. `searchKey` is a `CategoryId` or a `preset:<id>` string
 * (e.g. `preset:amenity/fuel`); both are resolved server-side.
 */
export function useRouteSearch(searchKey: string | null): UseRouteSearch {
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
  // position below, so they stay accurate between box refreshes.
  const bboxAlong = Math.floor(alongMeters / BBOX_STEP_M) * BBOX_STEP_M;
  const bbox = useMemo(
    () => (route ? routeAheadBounds(route.geometry, bboxAlong, LOOKAHEAD_M) : null),
    [route, bboxAlong],
  );

  // preset:* keys aren't CategoryIds but the search endpoint resolves them; the
  // hook only forwards the string, so the cast is safe.
  const query = useCategorySearch(
    searchKey ? (searchKey as CategoryId) : null,
    searchKey ? bbox : null,
    locale,
  );

  const results = useMemo(() => {
    if (!matcher || !query.data?.results) return [];
    return poiAlongRoute(query.data.results, matcher, alongMeters, {
      lookaheadMeters: LOOKAHEAD_M,
      speedMps: speedMps > 0 ? speedMps : undefined,
    });
  }, [matcher, query.data, alongMeters, speedMps]);

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

  return { results, isLoading: query.isLoading, isError: query.isError, addStop };
}
