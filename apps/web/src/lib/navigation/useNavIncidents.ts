"use client";

import {
  type BoundingBox,
  fetchRoadConditionsWithStatus,
  type LngLat,
  PROGRESS_BUCKET_METERS,
  type PreparedRouteMatcher,
  paddedRouteAheadBounds,
  prepareRouteMatcher,
  progressBucket,
  progressBucketStartMeters,
  projectEventsToRoute,
  type RoadConditionEvent,
  type Route,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type { NavIncidentResource, NavIncidentStatus } from "@openmapx/integration-framework/react";
import { useEffect, useMemo, useRef, useState } from "react";

/** Refetch this often so new closures/incidents appear mid-drive. */
const REFRESH_MS = 120_000;
/** Incidents beyond this are dropped from what consumers see — matches the old cap. */
const LOOKAHEAD_M = 25_000;
/**
 * The fetch window always reaches at least one bucket past the current one, so
 * the live position — anywhere inside its bucket — still retains a full 25 km
 * ahead horizon even right after crossing a bucket boundary.
 */
const WINDOW_LOOKAHEAD_M = PROGRESS_BUCKET_METERS + 25_000;

interface InternalState {
  /** The route this state belongs to; `null` once inactive/offline/disabled. */
  routeIdentity: Route | null;
  /** Last successfully-fetched raw events for `routeIdentity` (held across a failed refresh). */
  events: RoadConditionEvent[];
  status: NavIncidentStatus;
  successfulRevision: number;
}

const INACTIVE_STATE = (status: NavIncidentStatus): InternalState => ({
  routeIdentity: null,
  events: [],
  status,
  successfulRevision: 0,
});

/**
 * Sum of a bounding box's fetches, merged. A dateline crossing produces two
 * boxes from `paddedRouteAheadBounds`; both must succeed for the window to
 * count as fetched, since a half-fetched window would silently hide whichever
 * side failed.
 */
async function fetchWindow(
  boxes: BoundingBox[],
  signal: AbortSignal,
): Promise<{ ok: boolean; events: RoadConditionEvent[] }> {
  const results = await Promise.all(
    boxes.map((box) =>
      fetchRoadConditionsWithStatus([box.west, box.south, box.east, box.north], { signal }),
    ),
  );
  const ok = results.every((r) => r.ok);
  if (!ok) return { ok: false, events: [] };
  const byId = new Map<string, RoadConditionEvent>();
  for (const result of results) {
    for (const event of result.events) byId.set(event.id, event);
  }
  return { ok: true, events: [...byId.values()] };
}

/**
 * The single owner of ground-navigation road-condition data. Fetches the
 * route-ahead window from the `road-conditions` capability, keyed on route
 * identity + 5 km progress bucket (not on every fix), projects each response
 * onto the route once, and exposes a truthful freshness status so a
 * baseline-arming consumer can tell "no data yet" from "fetch failed" from
 * "fetched, genuinely empty". Mount exactly once — in the nav-incident
 * provider — and share the result via context; every other consumer reads
 * that context instead of calling this hook again.
 */
export function useNavIncidents(): NavIncidentResource {
  const route = useNavigationStore((s) => s.route);
  const kind = useNavigationStore((s) => s.kind);
  const navStatus = useNavigationStore((s) => s.status);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const connectivity = useNavigationStore((s) => s.connectivity);
  const setLiveDataUnavailable = useNavigationStore((s) => s.setLiveDataUnavailable);
  const fetchEnabled = incidentAlerts || avoidIncidents;
  // Transit and post-arrival sessions keep `route` populated for other UI, but
  // road conditions are a driving/cycling/walking concern — never fetch for them.
  const active = kind === "ground" && (navStatus === "navigating" || navStatus === "rerouting");

  const bucket = progressBucket(along);

  const [state, setState] = useState<InternalState>(() => INACTIVE_STATE("disabled"));

  // The route the LATEST effect run belongs to — updated synchronously, before
  // any fetch starts. A response whose owner no longer matches this ref came
  // from an effect run that a route change has since superseded, and must be
  // discarded even if it resolves after the newer run's own response (the
  // AbortController on the same request already covers the ordinary case; this
  // also covers a straggler that resolved just before its abort took effect).
  const ownerRouteRef = useRef<Route | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (connectivity === "offline") {
      abortRef.current?.abort();
      ownerRouteRef.current = null;
      setState(INACTIVE_STATE("offline"));
      setLiveDataUnavailable(true);
      return;
    }
    if (!active || !fetchEnabled || !route || route.geometry.length < 2) {
      abortRef.current?.abort();
      ownerRouteRef.current = route;
      setState(INACTIVE_STATE("disabled"));
      return;
    }

    const boxes = paddedRouteAheadBounds(
      route.geometry,
      progressBucketStartMeters(bucket),
      WINDOW_LOOKAHEAD_M,
    );
    if (!boxes) {
      ownerRouteRef.current = route;
      setState(INACTIVE_STATE("loading"));
      return;
    }

    // A route change clears any previous route's data immediately — before this
    // run's own fetch even starts — rather than leaving it on screen,
    // misprojected onto the new geometry, until the new route's first response
    // lands. A bucket-only change (same route) keeps showing held data while
    // the window refreshes underneath it, exactly like a periodic refresh.
    const isNewRoute = ownerRouteRef.current !== route;
    ownerRouteRef.current = route;
    if (isNewRoute) {
      setState({ routeIdentity: null, events: [], status: "loading", successfulRevision: 0 });
    }

    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void fetchWindow(boxes, controller.signal).then((result) => {
        if (controller.signal.aborted || ownerRouteRef.current !== route) return;
        setLiveDataUnavailable(!result.ok);
        setState((prev) => {
          if (result.ok) {
            return {
              routeIdentity: route,
              events: result.events,
              status: "fresh",
              successfulRevision: prev.successfulRevision + 1,
            };
          }
          // A previously-fresh (or already-stale) window keeps its held data —
          // only its truthfulness changes, from "current" to "aging". Before any
          // success there is nothing to hold onto, so it stays "loading": that
          // state must never be mistaken for a settled empty response.
          return {
            ...prev,
            status: prev.status === "fresh" || prev.status === "stale" ? "stale" : "loading",
          };
        });
      });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [route, bucket, fetchEnabled, connectivity, active, setLiveDataUnavailable]);

  // The active route's snap index, rebuilt only when the route identity
  // changes (mirrors `useNavigationEngine`'s `matcherRef`/`matcherFor`).
  const matcherRef = useRef<{ geometry: LngLat[]; matcher: PreparedRouteMatcher } | null>(null);

  // Route-matching (corridor/direction/road-name checks) is independent of the
  // live GPS position, so it runs only when the held events or the route
  // change — once per successful/settled revision — never per fix. Every
  // event on the route is projected here (no along-cutoff); the cheap
  // ahead-window filter below narrows that per fix.
  const projected = useMemo(() => {
    if (!state.routeIdentity) return [];
    const geometry = state.routeIdentity.geometry;
    const held = matcherRef.current;
    const matcher = held?.geometry === geometry ? held.matcher : prepareRouteMatcher(geometry);
    matcherRef.current = { geometry, matcher };
    return projectEventsToRoute(state.events, geometry, 0, {
      routeSteps: state.routeIdentity.steps,
      routeMatcher: matcher,
      lookaheadMeters: Number.POSITIVE_INFINITY,
    });
  }, [state.events, state.routeIdentity]);

  const incidents = useMemo(() => {
    if (state.status === "disabled" || state.status === "offline") return [];
    return projected.filter((incident) => {
      const ahead = incident.alongMeters - along;
      return ahead > 0 && ahead <= LOOKAHEAD_M;
    });
  }, [projected, along, state.status]);

  return useMemo(
    () => ({
      incidents,
      status: state.status,
      routeIdentity: state.routeIdentity,
      successfulRevision: state.successfulRevision,
    }),
    [incidents, state.status, state.routeIdentity, state.successfulRevision],
  );
}
