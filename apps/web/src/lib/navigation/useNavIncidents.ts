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
 * each render against the current along-distance. Returns
 * `{ incidents: [], ready: false }` before the first fetch resolves and on
 * any error — navigation must never break.
 *
 * Fetches whenever EITHER `incidentAlerts` OR `avoidIncidents` is on: display
 * consumers gate on `incidentAlerts`, the engine's closure-reroute gates on
 * `avoidIncidents`, and both need the same underlying data.
 */
export function useNavIncidents(): NavIncidentsResult {
  const route = useNavigationStore((s) => s.route);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const fetchEnabled = incidentAlerts || avoidIncidents;

  const [events, setEvents] = useState<RoadConditionEvent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!fetchEnabled || !route || route.geometry.length < 2) {
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
  }, [route, fetchEnabled]);

  const incidents = useMemo(
    () => (route ? projectEventsToRoute(events, route.geometry, along) : []),
    [events, route, along],
  );

  return useMemo(() => ({ incidents, ready }), [incidents, ready]);
}
