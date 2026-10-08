"use client";

import {
  type AlongRoutePoi,
  type BrandSummary,
  brandToFilter,
  type CategoryId,
  type CategoryPlace,
  cumulativeDistances,
  evaluateRouteStopDetours,
  fetchDirections,
  filterRoutePois,
  insertRouteStop,
  type LngLat,
  type OverpassFilter,
  paddedRouteAheadBounds,
  positionAt,
  prepareRouteMatcher,
  projectRoutePois,
  ROUTE_STOP_CACHE_MS,
  ROUTE_STOP_LIMIT,
  ROUTE_STOP_PROGRESS_METERS,
  type RouteStopCandidate,
  type RouteStopDetour,
  remainingRouteStopWaypoints,
  routeStopWaypointPositions,
  useCategorySearch,
  useFilterSearch,
  useNavigationStore,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  addStop: (candidate: RouteStopCandidate | LngLat) => Promise<boolean>;
  cancelAddStop: () => void;
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
  const mode = useNavigationStore((s) => s.mode);
  const options = useNavigationStore((s) => s.routeOptions);
  const provider = useNavigationStore((s) => s.routeProvider);
  const waypoints = useNavigationStore((s) => s.destinationWaypoints);
  const startedAt = useNavigationStore((s) => s.navigationStartedAtMs);
  const authority = useNavigationStore((s) => s.navigationAuthority);
  const status = useNavigationStore((s) => s.status);
  const live = status === "navigating";

  // One snap index for the active route, so a results refresh projects the whole
  // POI set — and prunes the waypoints for an added stop — against the same
  // index. A position fix alone never rebuilds it.
  const geometry = route?.geometry;
  const matcher = useMemo(() => (geometry ? prepareRouteMatcher(geometry) : null), [geometry]);
  const cumulative = useMemo(() => (geometry ? cumulativeDistances(geometry) : []), [geometry]);
  const intermediate = useMemo(
    () => (matcher ? routeStopWaypointPositions(matcher, waypoints) : []),
    [matcher, waypoints],
  );
  // Crossing a user stop changes the remaining itinerary even within a bucket.
  const remainingKey = intermediate
    .map((wp) => (wp.final || wp.alongMeters > alongMeters ? "1" : "0"))
    .join("");

  // Quantize so the query box (and its cache key) only changes every few km,
  // not on every position fix. Results are still filtered against the live
  // position below, so they stay accurate between box refreshes. Shared by
  // both search paths below, so a brand search issues corridor requests at the
  // same cadence a category search does.
  const bboxAlong = Math.floor(alongMeters / BBOX_STEP_M) * BBOX_STEP_M;
  const bbox = useMemo(
    () =>
      route
        ? (paddedRouteAheadBounds(route.geometry, bboxAlong, LOOKAHEAD_M + BBOX_STEP_M)?.[0] ??
          null)
        : null,
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

  const places = active.data?.results;
  const projections = useMemo(
    () => (matcher && places ? projectRoutePois(places, matcher) : []),
    [matcher, places],
  );
  const geometric = useMemo(
    () =>
      filterRoutePois(projections, alongMeters, {
        lookaheadMeters: LOOKAHEAD_M,
        speedMps: speedMps > 0 ? speedMps : undefined,
      }),
    [projections, alongMeters, speedMps],
  );

  const serial = useRef(0);
  const owner = useMemo(
    () => ({
      id: ++serial.current,
      route,
      options,
      provider,
      waypoints,
      startedAt,
      mode,
      authority,
    }),
    [route, options, provider, waypoints, startedAt, mode, authority],
  );
  const bucket = Math.floor(alongMeters / ROUTE_STOP_PROGRESS_METERS);
  const scope = categoryKey ?? JSON.stringify(filter);
  const enabled = query !== null;
  const evaluation = useMemo(() => {
    if (!matcher || !route || !enabled || authority !== "browser" || !live) return null;
    const reference = bucket * ROUTE_STOP_PROGRESS_METERS;
    const from = positionAt(route.geometry, cumulative, reference).point;
    const tail = [
      from,
      ...intermediate.filter((_, i) => remainingKey[i] === "1").map((wp) => wp.coordinates),
    ];
    const candidates = filterRoutePois(projections, reference, { lookaheadMeters: LOOKAHEAD_M })
      .slice(0, ROUTE_STOP_LIMIT)
      .map((poi) => poi.place);
    const key = JSON.stringify([
      owner.id,
      scope,
      locale,
      bucket,
      tail,
      candidates.map((p) => [p.id, p.coordinates, p.routingEntrance]),
    ]);
    return { key, candidates, tail, owner };
  }, [
    matcher,
    route,
    authority,
    live,
    bucket,
    projections,
    owner,
    scope,
    locale,
    enabled,
    cumulative,
    intermediate,
    remainingKey,
  ]);
  const cache = useRef(new Map<string, { results: RouteStopDetour[]; expiresAt: number }>());
  const targets = useMemo(
    () =>
      new Map(
        (places ?? []).map((p) => [p.id, JSON.stringify([p.coordinates, p.routingEntrance])]),
      ),
    [places],
  );
  const selectionScope = useRef({ scope, enabled, locale, targets });
  selectionScope.current = { scope, enabled, locale, targets };
  const [verified, setVerified] = useState<{
    key: string;
    results: RouteStopDetour[];
    expiresAt: number;
  } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  useEffect(() => {
    if (!evaluation || !matcher || evaluation.candidates.length === 0) {
      cache.current.clear();
      setVerified(null);
      setChecking(null);
      return;
    }
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const publish = (entry: { results: RouteStopDetour[]; expiresAt: number }) => {
      if (controller.signal.aborted) return;
      setVerified({ key: evaluation.key, ...entry });
      setChecking(null);
      expiry = setTimeout(
        () => setVerified((current) => (current?.key === evaluation.key ? null : current)),
        Math.max(0, entry.expiresAt - Date.now()),
      );
    };
    const cached = cache.current.get(evaluation.key);
    if (cached && cached.expiresAt > Date.now()) publish(cached);
    else {
      setChecking(evaluation.key);
      void evaluateRouteStopDetours({
        route: matcher,
        alongMeters: bucket * ROUTE_STOP_PROGRESS_METERS,
        waypoints: evaluation.tail,
        candidates: evaluation.candidates,
        provider: provider ?? undefined,
        signal: controller.signal,
        requestRoute: ({ waypoints, provider, signal }) =>
          fetchDirections({ waypoints, provider, mode, ...options, lang: locale }, undefined, {
            signal,
            timeoutMs: 15_000,
          }),
      })
        .then((results) => {
          if (controller.signal.aborted) return;
          const entry = { results, expiresAt: Date.now() + ROUTE_STOP_CACHE_MS };
          cache.current.delete(evaluation.key);
          cache.current.set(evaluation.key, entry);
          while (cache.current.size > 64) {
            const oldest = cache.current.keys().next().value;
            if (oldest === undefined) break;
            cache.current.delete(oldest);
          }
          publish(entry);
        })
        .catch(() => {
          if (!controller.signal.aborted) setChecking(null);
        });
    }
    return () => {
      controller.abort();
      if (expiry) clearTimeout(expiry);
    };
  }, [evaluation, matcher, provider, mode, options, locale, bucket]);
  const results = useMemo(() => {
    const current =
      verified?.key === evaluation?.key && verified && verified.expiresAt > Date.now()
        ? verified.results
        : [];
    const estimates = new Map(current.map((detour) => [detour.id, detour]));
    return geometric.map((poi) => {
      const detour = estimates.get(poi.place.id);
      return {
        ...poi,
        ...(detour ? { detour } : {}),
        ...(checking === evaluation?.key &&
        evaluation?.candidates.some((p) => p.id === poi.place.id)
          ? { detourPending: true }
          : {}),
        ...(detour?.kind === "network"
          ? { detourSeconds: detour.seconds, detourMeters: detour.meters }
          : {}),
      };
    });
  }, [geometric, verified, evaluation, checking]);
  const adding = useRef<{
    controller: AbortController;
    ownsRoute: () => boolean;
    selectionCurrent: () => boolean;
  } | null>(null);
  const cancelAddStop = useCallback(() => {
    const pending = adding.current;
    if (!pending) return;
    const restore = pending.ownsRoute();
    pending.controller.abort();
    adding.current = null;
    if (restore) useNavigationStore.setState({ status: "navigating" });
  }, []);
  useEffect(() => {
    void scope;
    void enabled;
    void locale;
    void targets;
    if (adding.current && !adding.current.selectionCurrent()) cancelAddStop();
  }, [scope, enabled, locale, targets, cancelAddStop]);
  useEffect(
    () => () => {
      cancelAddStop();
      cache.current.clear();
    },
    [cancelAddStop],
  );

  const addStop = async (selection: RouteStopCandidate | LngLat): Promise<boolean> => {
    cancelAddStop();
    const store = useNavigationStore.getState();
    const { route: r, mode, destinationWaypoints, progress } = store;
    if (!r || store.navigationAuthority !== "browser" || store.status !== "navigating")
      return false;
    const controller = new AbortController();
    const coord = Array.isArray(selection) ? selection : selection.coordinates;
    const matches = results.filter((poi) =>
      Array.isArray(selection)
        ? poi.place.coordinates[0] === coord[0] && poi.place.coordinates[1] === coord[1]
        : poi.place.id === selection.id,
    );
    // Coordinate-only compatibility callers cannot disambiguate co-located sites.
    if (matches.length > 1 || (!Array.isArray(selection) && matches.length !== 1)) return false;
    const candidate = matches[0];
    if (candidate?.detour?.kind === "unreachable") return false;
    const requestedProvider =
      store.routeProvider ??
      (candidate?.detour?.kind === "network" ? candidate.detour.provider : undefined);
    const captured = selectionScope.current;
    const selectedTarget = candidate
      ? JSON.stringify([candidate.place.coordinates, candidate.place.routingEntrance])
      : undefined;
    const selectionCurrent = () => {
      const current = selectionScope.current;
      return (
        current.scope === captured.scope &&
        current.enabled === captured.enabled &&
        current.locale === captured.locale &&
        (!candidate || current.targets.get(candidate.place.id) === selectedTarget)
      );
    };
    if (!selectionCurrent()) return false;
    const target = candidate?.place.routingEntrance ?? candidate?.place.coordinates ?? coord;
    const from = progress?.snapped ?? destinationWaypoints[0] ?? coord;
    // The store's route wins if a reroute landed since the last render, in which
    // case the memoized index no longer describes it and the geometry is used.
    const positions =
      r === route && destinationWaypoints === waypoints
        ? intermediate
        : routeStopWaypointPositions(r.geometry, destinationWaypoints);
    const tail = remainingRouteStopWaypoints(positions, from, progress?.alongMeters ?? 0);
    const nextWaypoints = insertRouteStop(
      matcher?.geometry === r.geometry ? matcher : r.geometry,
      tail,
      target,
      progress?.alongMeters ?? 0,
    );
    if (nextWaypoints.length < 3) return false;

    store.beginReroute();
    const ownsRoute = () => {
      const current = useNavigationStore.getState();
      return (
        current.route === r &&
        current.routeOptions === store.routeOptions &&
        current.routeProvider === store.routeProvider &&
        current.destinationWaypoints === destinationWaypoints &&
        current.navigationStartedAtMs === store.navigationStartedAtMs &&
        current.navigationAuthority === "browser" &&
        current.status === "rerouting"
      );
    };
    const pending = { controller, ownsRoute, selectionCurrent };
    adding.current = pending;
    const stillNavigating = () =>
      !controller.signal.aborted && adding.current === pending && ownsRoute() && selectionCurrent();
    const unsubscribe = useNavigationStore.subscribe(() => {
      if (!stillNavigating()) controller.abort();
    });
    try {
      const res = await fetchDirections(
        {
          waypoints: nextWaypoints,
          mode,
          provider: requestedProvider,
          ...store.routeOptions,
          lang: locale,
        },
        undefined,
        { signal: controller.signal, timeoutMs: 15_000 },
      );
      if (!stillNavigating()) return false;
      const next = res.routes?.[res.activeRouteIndex ?? 0];
      if (!next || (requestedProvider && res.provider !== requestedProvider)) {
        useNavigationStore.setState({ status: "navigating" });
        useNavigationStore.getState().signalRerouteFailed();
        return false;
      }
      useNavigationStore.getState().addStop(next, nextWaypoints, res.provider);
      return true;
    } catch {
      if (stillNavigating()) {
        useNavigationStore.setState({ status: "navigating" });
        useNavigationStore.getState().signalRerouteFailed();
      }
      return false;
    } finally {
      unsubscribe();
      if (adding.current === pending) {
        if (ownsRoute()) useNavigationStore.setState({ status: "navigating" });
        adding.current = null;
      }
    }
  };

  return { results, isLoading: active.isLoading, isError: active.isError, addStop, cancelAddStop };
}
