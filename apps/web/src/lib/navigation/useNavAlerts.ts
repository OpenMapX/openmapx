"use client";

import {
  type ActiveAlert,
  type AlongRange,
  type BoundingBox,
  CAMERA_RESTRICTED_COUNTRIES,
  cumulativeDistances,
  fetchRoadAlerts,
  type LngLat,
  PROGRESS_BUCKET_METERS,
  paddedRouteAheadBounds,
  progressBucket,
  progressBucketStartMeters,
  projectRoadAlertsOntoRoute,
  type RawRoadAlert,
  type RoadAlert,
  type Route,
  selectActiveAlert,
  useCountryFromCoordinates,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { useEffect, useMemo, useRef, useState } from "react";

/** Skip fetching for corridors larger than this (deg²); mirrors the server cap. */
const MAX_BBOX_DEG2 = 0.6;
/**
 * Largest approach window `selectActiveAlert` uses for anything this hook can
 * fetch. The server's OSM alert endpoint only ever emits `speed_camera`,
 * `railway_crossing`, `stop`, and `traffic_calming` (see `mapAlertElements` in
 * `integrations/routing/navigation-alerts.ts`); of their entries in the
 * `APPROACH` table in `packages/core/src/navigation/alerts.ts`,
 * `speed_camera`'s 500 m `maxM` is the largest. A query window shorter than
 * that could miss an alert the selector would otherwise have surfaced.
 */
const MAX_APPROACH_M = 500;
/**
 * The fetch window always reaches at least one bucket past the current one, so
 * the live position — anywhere inside its bucket — still retains the full
 * approach horizon right after crossing a bucket boundary.
 */
const WINDOW_LOOKAHEAD_M = PROGRESS_BUCKET_METERS + MAX_APPROACH_M;
/** Deepest along-route halving before giving up and querying the box as-is. */
const MAX_SPLIT_DEPTH = 4;

function boxAreaDeg2(box: BoundingBox): number {
  return Math.abs(box.north - box.south) * Math.abs(box.east - box.west);
}

/**
 * Ahead-window boxes for the OSM alert query, halved along the route whenever
 * a box would exceed the server's area cap. A winding route can blow the cap
 * even over this hook's short lookahead; splitting keeps alerts flowing for
 * that stretch instead of dropping every alert on the route the way a single
 * oversized query used to. Deterministic — the same geometry and window
 * always produce the same split, never time- or randomness-dependent.
 */
function alertWindowBoxes(
  geometry: LngLat[],
  fromAlongMeters: number,
  lookaheadMeters: number,
  depth = 0,
): BoundingBox[] {
  const boxes = paddedRouteAheadBounds(geometry, fromAlongMeters, lookaheadMeters);
  if (!boxes) return [];
  const oversized = boxes.some((box) => boxAreaDeg2(box) > MAX_BBOX_DEG2);
  if (!oversized || depth >= MAX_SPLIT_DEPTH) return boxes;
  const half = lookaheadMeters / 2;
  return [
    ...alertWindowBoxes(geometry, fromAlongMeters, half, depth + 1),
    ...alertWindowBoxes(geometry, fromAlongMeters + half, half, depth + 1),
  ];
}

/** Alerts fetched for one ahead-window, and the along-route span that window covers. */
interface WindowAlerts {
  alerts: RawRoadAlert[];
  range: AlongRange;
}

const NO_ALERTS: WindowAlerts = { alerts: [], range: { fromMeters: 0, toMeters: 0 } };

/**
 * Approach alert to surface right now along the active route, or null. Fetches
 * OSM alert POIs in a bounded ahead-window (keyed on route identity + progress
 * bucket, like `useNavIncidents`), attaches those the route arrives at along
 * their own road in a direction they apply to (`projectRoadAlertsOntoRoute`),
 * and picks the nearest in-range one each fix. Speed cameras are dropped unless
 * the user opted in AND the route origin's country permits them.
 */
export function useNavAlerts(incidentResource: NavIncidentResource): ActiveAlert | null {
  const route = useNavigationStore((s) => s.route);
  const along = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const speed = useNavigationStore((s) => s.progress?.speedMps ?? 0);
  const speedCameraAlerts = useSettingsStore((s) => s.speedCameraAlerts);
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);
  const connectivity = useNavigationStore((s) => s.connectivity);
  const bucket = progressBucket(along);

  const origin = (route?.geometry[0] ?? null) as LngLat | null;
  // Only worth asking when the answer can change the outcome: the camera
  // opt-in defaults off, so most drives would otherwise pay for a reverse
  // geocode whose result is thrown away.
  const countryQueryEnabled = !!route && connectivity === "online" && speedCameraAlerts;
  const { data: country } = useCountryFromCoordinates(origin, countryQueryEnabled);
  // `data` stays `undefined` until the query's first resolution (and forever
  // while disabled). Treating that gap as "permitted" — the old behaviour —
  // would let a camera flash up in a restricted country during the moment
  // right after the setting is switched on, before the legal region is known.
  const countryUnknown = countryQueryEnabled && country === undefined;

  const [raw, setRaw] = useState<WindowAlerts>(NO_ALERTS);

  // The route the LATEST effect run belongs to, and a generation counter for
  // its fetch — `fetchRoadAlerts` has no abort signal, so a stale response is
  // discarded by this guard rather than by cancelling the request itself.
  const ownerRouteRef = useRef<Route | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (connectivity === "offline" || !route || route.geometry.length < 2) {
      requestIdRef.current += 1;
      ownerRouteRef.current = route ?? null;
      setRaw(NO_ALERTS);
      return;
    }

    // A route change drops the previous route's alerts immediately, rather
    // than leaving them on screen (misprojected onto the new geometry) until
    // the new route's first response lands. A bucket-only change (same
    // route, driver has advanced) keeps showing held alerts while the window
    // refreshes underneath it.
    const isNewRoute = ownerRouteRef.current !== route;
    ownerRouteRef.current = route;

    const windowStart = progressBucketStartMeters(bucket);
    const boxes = alertWindowBoxes(route.geometry, windowStart, WINDOW_LOOKAHEAD_M);
    if (boxes.length === 0) {
      requestIdRef.current += 1;
      setRaw(NO_ALERTS);
      return;
    }
    if (isNewRoute) setRaw(NO_ALERTS);

    const requestId = ++requestIdRef.current;
    void Promise.all(boxes.map((box) => fetchRoadAlerts(box)))
      .then((results) => {
        if (requestIdRef.current !== requestId) return; // superseded by a newer route/bucket
        const byId = new Map<string, RawRoadAlert>();
        for (const list of results) {
          for (const a of list) byId.set(a.id, a);
        }
        setRaw({
          alerts: [...byId.values()],
          range: { fromMeters: windowStart, toMeters: windowStart + WINDOW_LOOKAHEAD_M },
        });
      })
      .catch(() => undefined);
  }, [route, bucket, connectivity]);

  // Along-route distances of the active route, recomputed only when it changes.
  const cum = useMemo(() => (route ? cumulativeDistances(route.geometry) : []), [route]);

  // Attach each fetched alert where the route meets it on its own road, in a
  // direction it applies to — never merely because it stands near the line.
  const projected: RoadAlert[] = useMemo(() => {
    if (!route || connectivity === "offline" || route.geometry.length < 2) return [];
    return projectRoadAlertsOntoRoute(raw.alerts, route.geometry, cum, raw.range);
  }, [raw, route, cum, connectivity]);

  // Apply the speed-camera opt-in + legal region gate.
  const alerts: RoadAlert[] = useMemo(() => {
    const cameraAllowed =
      speedCameraAlerts &&
      !countryUnknown &&
      !(country != null && CAMERA_RESTRICTED_COUNTRIES.has(country));
    return cameraAllowed ? projected : projected.filter((a) => a.type !== "speed_camera");
  }, [projected, speedCameraAlerts, country, countryUnknown]);

  // Traffic incidents (from the road-conditions capability) merge into the same
  // selector as the OSM hazards; they carry priority 0, so an in-range incident
  // is surfaced before a speed camera or crossing. Only included when the user
  // has incident alerts on; the fetch may still be active for avoidIncidents.
  const { incidents } = incidentResource;
  const visibleIncidents = incidentAlerts && connectivity === "online" ? incidents : [];

  return useMemo(
    () => selectActiveAlert([...visibleIncidents, ...alerts], along, speed, []),
    [visibleIncidents, alerts, along, speed],
  );
}
