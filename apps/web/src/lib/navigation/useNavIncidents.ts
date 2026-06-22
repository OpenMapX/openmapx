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

/**
 * Road-condition incidents projected onto the active route as severity-scaled
 * approach alerts. Fetches the route-ahead bbox from the `road-conditions`
 * capability once per route (refreshed on a coarse interval), then projects
 * each render against the current along-distance. Empty when the user has turned
 * incident alerts off. Returns [] on any error — navigation must never break.
 */
export function useNavIncidents(): IncidentAlert[] {
  const route = useNavigationStore((s) => s.route);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const enabled = useSettingsStore((s) => s.incidentAlerts);

  const [events, setEvents] = useState<RoadConditionEvent[]>([]);

  useEffect(() => {
    if (!enabled || !route || route.geometry.length < 2) {
      setEvents([]);
      return;
    }
    const box = routeAheadBounds(route.geometry, 0);
    if (!box) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void fetchRoadConditions([box.west, box.south, box.east, box.north]).then((e) => {
        if (!cancelled) setEvents(e);
      });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [route, enabled]);

  return useMemo(
    () => (route ? projectEventsToRoute(events, route.geometry, along) : []),
    [events, route, along],
  );
}
