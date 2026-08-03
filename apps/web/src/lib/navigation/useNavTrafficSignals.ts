import {
  cumulativeDistances,
  fetchRouteMatchWindow,
  type LngLat,
  signalCoordKey,
  useNavigationStore,
  windowGeometry,
} from "@openmapx/core";
import { useEffect, useMemo, useRef, useState } from "react";

/** Max points per /match request — safely under Valhalla's 5000-point cap. */
const MAX_TRACE_POINTS = 4500;
/** Fetch the next window once the driver is within this far of its end (m). */
const PREFETCH_METERS = 2000;

/** Write a window's per-point speed limits into the route-indexed array at `start`. */
function writeLimits(arr: (number | null)[], start: number, perPoint: (number | null)[]): void {
  for (let j = 0; j < perPoint.length; j++) {
    const idx = start + j;
    if (idx < arr.length && perPoint[j] !== null) arr[idx] = perPoint[j];
  }
}

/**
 * Road attributes along the active route, fetched up front from the route's
 * windowed map-match. Returns the traffic-signal coordinates (the icon layer's
 * only input) and, as a side effect, publishes the posted speed limit per
 * `route.geometry` index into the navigation store (`liveSpeedLimits`) so the
 * engine can read the live limit for the segment the user is on without polling
 * per fix — both ride a single /match request per window.
 *
 * The first window is fetched when the route is set (or replaced on reroute) and
 * later windows are prefetched as the driver nears each window's end. On a route
 * longer than one window (>4500 pts), a position in a not-yet-fetched window
 * (e.g. after a large forward GPS jump) reports an unknown limit until the window
 * is prefetched — an accepted trade-off for dropping the per-fix map-match poll.
 */
export function useNavTrafficSignals(): LngLat[] {
  const route = useNavigationStore((s) => s.route);
  const alongMeters = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const mode = useNavigationStore((s) => s.mode);
  const connectivity = useNavigationStore((s) => s.connectivity);
  const setLiveSpeedLimits = useNavigationStore((s) => s.setLiveSpeedLimits);
  const setLiveDataUnavailable = useNavigationStore((s) => s.setLiveDataUnavailable);

  const [signals, setSignals] = useState<LngLat[]>([]);
  const windowRef = useRef({ nextStart: 0, endMeters: 0, done: true });
  const fetchingRef = useRef(false);
  // Speed limits accumulated across windows, indexed by route.geometry point.
  const limitsRef = useRef<(number | null)[]>([]);
  // Bumped on every route change so a fetch still in flight from the previous
  // route can't apply its (now stale) attributes to the new one.
  const genRef = useRef(0);

  // Cumulative distances along the route, computed once per route and reused by
  // every window advance so we never re-walk the full geometry per fix.
  const cum = useMemo(() => (route ? cumulativeDistances(route.geometry) : []), [route]);

  // Reset + fetch the first window whenever the active route changes (fresh
  // start or applied reroute). Clears when there is no usable route.
  useEffect(() => {
    genRef.current += 1;
    fetchingRef.current = false;
    if (connectivity === "offline" || !route || route.geometry.length < 2) {
      setSignals([]);
      setLiveSpeedLimits(null);
      if (connectivity === "offline") setLiveDataUnavailable(true);
      limitsRef.current = [];
      windowRef.current = { nextStart: 0, endMeters: 0, done: true };
      return;
    }
    const gen = genRef.current;
    limitsRef.current = new Array(route.geometry.length).fill(null);
    setLiveSpeedLimits(null);
    const w = windowGeometry(route.geometry, 0, MAX_TRACE_POINTS, cum);
    windowRef.current = { nextStart: w.nextStart, endMeters: w.endMeters, done: w.done };
    fetchingRef.current = true;
    fetchRouteMatchWindow(w.trace, mode)
      .then(({ signals: found, speedLimitsByPoint }) => {
        if (genRef.current !== gen) return;
        setSignals(found);
        writeLimits(limitsRef.current, 0, speedLimitsByPoint);
        setLiveSpeedLimits([...limitsRef.current]);
        setLiveDataUnavailable(false);
      })
      .catch(() => {
        if (genRef.current === gen) setLiveDataUnavailable(true);
      })
      .finally(() => {
        // Only release the lock if this is still the active generation; a stale
        // previous-route fetch must not clear the new route's in-flight flag.
        if (genRef.current === gen) fetchingRef.current = false;
      });
  }, [route, mode, cum, connectivity, setLiveDataUnavailable, setLiveSpeedLimits]);

  // Advance the window as the driver nears its far edge (long routes only).
  useEffect(() => {
    if (connectivity === "offline" || !route || windowRef.current.done || fetchingRef.current)
      return;
    if (alongMeters < windowRef.current.endMeters - PREFETCH_METERS) return;
    fetchingRef.current = true;
    const gen = genRef.current;
    const startIndex = windowRef.current.nextStart;
    // Advance the window ref BEFORE the async fetch so a segment with no signals
    // still moves us forward (or to done) and can't re-trigger this effect on
    // every fix.
    const w = windowGeometry(route.geometry, startIndex, MAX_TRACE_POINTS, cum);
    windowRef.current = { nextStart: w.nextStart, endMeters: w.endMeters, done: w.done };
    fetchRouteMatchWindow(w.trace, mode)
      .then(({ signals: found, speedLimitsByPoint }) => {
        if (genRef.current !== gen) return;
        if (speedLimitsByPoint.length > 0) {
          writeLimits(limitsRef.current, startIndex, speedLimitsByPoint);
          setLiveSpeedLimits([...limitsRef.current]);
        }
        setLiveDataUnavailable(false);
        if (found.length === 0) return;
        setSignals((prev) => {
          const seen = new Set(prev.map(signalCoordKey));
          const merged = [...prev];
          for (const c of found) {
            const key = signalCoordKey(c);
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(c);
            }
          }
          return merged;
        });
      })
      .catch(() => {
        if (genRef.current === gen) setLiveDataUnavailable(true);
      })
      .finally(() => {
        if (genRef.current === gen) fetchingRef.current = false;
      });
  }, [alongMeters, route, mode, cum, connectivity, setLiveDataUnavailable, setLiveSpeedLimits]);

  return signals;
}
