"use client";

import {
  type ActiveAlert,
  CAMERA_RESTRICTED_COUNTRIES,
  fetchRoadAlerts,
  geoJsonBBox,
  type LngLat,
  type RawRoadAlert,
  type RoadAlert,
  selectActiveAlert,
  snapToRoute,
  useCountryFromCoordinates,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useEffect, useMemo, useState } from "react";
import { useNavIncidents } from "./useNavIncidents";

/** An alert must sit within this distance (m) of the route to be relevant. */
const MAX_DEVIATION_M = 25;
/** Skip fetching for corridors larger than this (deg²); mirrors the server cap. */
const MAX_BBOX_DEG2 = 0.6;

/**
 * Approach alert to surface right now along the active route, or null. Fetches
 * OSM alert POIs in the route's bounding box once per route, projects them onto
 * the line, and picks the nearest in-range one each fix. Speed cameras are
 * dropped unless the user opted in AND the route origin's country permits them.
 */
export function useNavAlerts(): ActiveAlert | null {
  const route = useNavigationStore((s) => s.route);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const speed = useNavigationStore((s) => s.progress?.speedMps ?? 0);
  const speedCameraAlerts = useSettingsStore((s) => s.speedCameraAlerts);
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);

  const origin = (route?.geometry[0] ?? null) as LngLat | null;
  const { data: country } = useCountryFromCoordinates(origin, !!route);

  const [raw, setRaw] = useState<RawRoadAlert[]>([]);

  useEffect(() => {
    if (!route || route.geometry.length < 2) {
      setRaw([]);
      return;
    }
    const box = geoJsonBBox({ type: "LineString", coordinates: route.geometry });
    if (!box) {
      setRaw([]);
      return;
    }
    const [west, south, east, north] = box;
    if (Math.abs(north - south) * Math.abs(east - west) > MAX_BBOX_DEG2) {
      setRaw([]); // too large; the server would skip it too
      return;
    }
    let cancelled = false;
    fetchRoadAlerts({ south, west, north, east }).then((a) => {
      if (!cancelled) setRaw(a);
    });
    return () => {
      cancelled = true;
    };
  }, [route]);

  // Project each raw alert onto the route, keep those on/near the line, and
  // apply the speed-camera opt-in + legal region gate.
  const alerts: RoadAlert[] = useMemo(() => {
    if (!route) return [];
    const cameraAllowed =
      speedCameraAlerts && !(country != null && CAMERA_RESTRICTED_COUNTRIES.has(country));
    const out: RoadAlert[] = [];
    for (const a of raw) {
      if (a.type === "speed_camera" && !cameraAllowed) continue;
      const snap = snapToRoute(route.geometry, [a.lng, a.lat]);
      if (snap.deviationMeters > MAX_DEVIATION_M) continue;
      out.push({
        id: a.id,
        type: a.type,
        coord: [a.lng, a.lat],
        alongMeters: snap.alongMeters,
        speedLimitKmh: a.speedLimitKmh,
      });
    }
    return out;
  }, [raw, route, speedCameraAlerts, country]);

  // Traffic incidents (from the road-conditions capability) merge into the same
  // selector as the OSM hazards; they carry priority 0, so an in-range incident
  // is surfaced before a speed camera or crossing. Only included when the user
  // has incident alerts on; the fetch may still be active for avoidIncidents.
  const { incidents } = useNavIncidents();
  const visibleIncidents = incidentAlerts ? incidents : [];

  return useMemo(
    () => selectActiveAlert([...visibleIncidents, ...alerts], along, speed, []),
    [visibleIncidents, alerts, along, speed],
  );
}
