"use client";

import {
  type ActiveAlert,
  type BoundingBox,
  CAMERA_RESTRICTED_COUNTRIES,
  fetchRoadAlerts,
  type LngLat,
  PROGRESS_BUCKET_METERS,
  type PreparedRouteMatcher,
  paddedRouteAheadBounds,
  prepareRouteMatcher,
  progressBucket,
  progressBucketStartMeters,
  type RawRoadAlert,
  type RoadAlert,
  type Route,
  selectActiveAlert,
  snapPreparedRoute,
  useCountryFromCoordinates,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { useEffect, useMemo, useRef, useState } from "react";

/** An alert must sit within this distance (m) of the route to be relevant. */
const MAX_DEVIATION_M = 25;
/** Skip fetching for corridors larger than this (deg²); mirrors the server cap. */
const MAX_BBOX_DEG2 = 0.6;
/**
 * Largest approach window `selectActiveAlert` uses for anything this hook can
 * fetch. The server's OSM alert endpoint only ever emits `speed_camera`,
 * `railway_crossing`, `stop`, and `traffic_calming` (see `mapAlertElements` in
 * `integrations/routing/index.ts`); of their entries in the `APPROACH` table in
 * `packages/core/src/navigation/alerts.ts`, `speed_camera`'s 500 m `maxM` is the
 * largest. A query window shorter than that could miss an alert the selector
 * would otherwise have surfaced.
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

/**
 * Approach alert to surface right now along the active route, or null. Fetches
 * OSM alert POIs in a bounded ahead-window (keyed on route identity + progress
 * bucket, like `useNavIncidents`), projects them onto the line, and picks the
 * nearest in-range one each fix. Speed cameras are dropped unless the user
 * opted in AND the route origin's country permits them.
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

  const [raw, setRaw] = useState<RawRoadAlert[]>([]);

  // The route the LATEST effect run belongs to, and a generation counter for
  // its fetch — `fetchRoadAlerts` has no abort signal, so a stale response is
  // discarded by this guard rather than by cancelling the request itself.
  const ownerRouteRef = useRef<Route | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (connectivity === "offline" || !route || route.geometry.length < 2) {
      requestIdRef.current += 1;
      ownerRouteRef.current = route ?? null;
      setRaw([]);
      return;
    }

    // A route change drops the previous route's alerts immediately, rather
    // than leaving them on screen (misprojected onto the new geometry) until
    // the new route's first response lands. A bucket-only change (same
    // route, driver has advanced) keeps showing held alerts while the window
    // refreshes underneath it.
    const isNewRoute = ownerRouteRef.current !== route;
    ownerRouteRef.current = route;

    const boxes = alertWindowBoxes(
      route.geometry,
      progressBucketStartMeters(bucket),
      WINDOW_LOOKAHEAD_M,
    );
    if (boxes.length === 0) {
      requestIdRef.current += 1;
      setRaw([]);
      return;
    }
    if (isNewRoute) setRaw([]);

    const requestId = ++requestIdRef.current;
    Promise.all(boxes.map((box) => fetchRoadAlerts(box))).then((results) => {
      if (requestIdRef.current !== requestId) return; // superseded by a newer route/bucket
      const byId = new Map<string, RawRoadAlert>();
      for (const list of results) {
        for (const a of list) byId.set(a.id, a);
      }
      setRaw([...byId.values()]);
    });
  }, [route, bucket, connectivity]);

  // The active route's snap index, rebuilt only when the route identity
  // changes (mirrors `useNavIncidents`'s `matcherRef`).
  const matcherRef = useRef<{ geometry: LngLat[]; matcher: PreparedRouteMatcher } | null>(null);

  // Project each raw alert onto the route, keep those on/near the line, and
  // apply the speed-camera opt-in + legal region gate.
  const alerts: RoadAlert[] = useMemo(() => {
    if (!route || connectivity === "offline") return [];
    const geometry = route.geometry;
    const held = matcherRef.current;
    const matcher = held?.geometry === geometry ? held.matcher : prepareRouteMatcher(geometry);
    matcherRef.current = { geometry, matcher };

    const cameraAllowed =
      speedCameraAlerts &&
      !countryUnknown &&
      !(country != null && CAMERA_RESTRICTED_COUNTRIES.has(country));
    const out: RoadAlert[] = [];
    for (const a of raw) {
      if (a.type === "speed_camera" && !cameraAllowed) continue;
      const snap = snapPreparedRoute(matcher, [a.lng, a.lat]);
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
  }, [raw, route, speedCameraAlerts, country, countryUnknown, connectivity]);

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
