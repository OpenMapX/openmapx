"use client";

import {
  fetchRoadConditions,
  type IncidentAlert,
  projectEventsToRoute,
  type RoadConditionEvent,
  routeAheadBounds,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useEffect, useMemo, useState } from "react";

/** Refetch incidents this often so new ones appear mid-drive. */
const REFRESH_MS = 120_000;

export interface NavIncidentsResult {
  incidents: IncidentAlert[];
  /**
   * True once the first `fetchRoadConditions` call for the CURRENT route has
   * resolved (empty or not). Resets to false whenever the route changes so
   * callers can distinguish "fetch not yet complete" from "fetched, no events".
   * Used by `useNavigationEngine` to establish the known-closures baseline only
   * after the initial fetch, avoiding spurious reroutes on navigation start.
   */
  ready: boolean;
}

/**
 * Road-condition incidents projected onto the active route as severity-scaled
 * approach alerts. Fetches the route-ahead bbox from the `road-conditions`
 * capability once per route (refreshed on a coarse interval), then projects
 * each render against the current along-distance. Empty when the user has turned
 * incident alerts off. Returns `{ incidents: [], ready: false }` before the
 * first fetch resolves, and on any error — navigation must never break.
 */
export function useNavIncidents(): NavIncidentsResult {
  const route = useNavigationStore((s) => s.route);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const enabled = useSettingsStore((s) => s.incidentAlerts);

  const [events, setEvents] = useState<RoadConditionEvent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled || !route || route.geometry.length < 2) {
      setEvents([]);
      setReady(false);
      return;
    }
    const box = routeAheadBounds(route.geometry, 0);
    if (!box) {
      setEvents([]);
      setReady(false);
      return;
    }
    let cancelled = false;
    let firstLoad = true;
    const load = () => {
      void fetchRoadConditions([box.west, box.south, box.east, box.north]).then((e) => {
        if (cancelled) return;
        setEvents(e);
        if (firstLoad) {
          firstLoad = false;
          setReady(true);
        }
      });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setReady(false);
    };
  }, [route, enabled]);

  const incidents = useMemo(
    () => (route ? projectEventsToRoute(events, route.geometry, along) : []),
    [events, route, along],
  );

  return useMemo(() => ({ incidents, ready }), [incidents, ready]);
}
