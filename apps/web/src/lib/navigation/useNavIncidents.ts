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
const LOOKAHEAD_M = 25_000;

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
  const connectivity = useNavigationStore((s) => s.connectivity);
  const setLiveDataUnavailable = useNavigationStore((s) => s.setLiveDataUnavailable);
  const fetchEnabled = incidentAlerts || avoidIncidents;

  const [events, setEvents] = useState<RoadConditionEvent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (connectivity === "offline") {
      setEvents([]);
      setReady(false);
      setLiveDataUnavailable(true);
      return;
    }
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
      void fetchRoadConditions([box.west, box.south, box.east, box.north])
        .then((e) => {
          if (cancelled) return;
          setEvents(e);
          setLiveDataUnavailable(false);
          if (firstLoad) {
            firstLoad = false;
            setReady(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setEvents([]);
          setLiveDataUnavailable(true);
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
  }, [route, fetchEnabled, connectivity, setLiveDataUnavailable]);

  // Geometry/road/direction matching is intentionally independent of the live
  // GPS position, so perform the expensive route match only when events or the
  // route change. The cheap ahead-window filter may then run on every fix.
  const projected = useMemo(
    () =>
      route && connectivity === "online"
        ? projectEventsToRoute(events, route.geometry, 0, {
            routeSteps: route.steps,
            lookaheadMeters: Number.POSITIVE_INFINITY,
          })
        : [],
    [events, route, connectivity],
  );
  const incidents = useMemo(
    () =>
      connectivity === "offline"
        ? []
        : projected.filter((incident) => {
            const ahead = incident.alongMeters - along;
            return ahead > 0 && ahead <= LOOKAHEAD_M;
          }),
    [projected, along, connectivity],
  );

  return useMemo(() => ({ incidents, ready }), [incidents, ready]);
}
