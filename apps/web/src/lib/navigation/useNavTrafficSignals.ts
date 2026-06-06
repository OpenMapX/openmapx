import {
  cumulativeDistances,
  fetchTrafficSignals,
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

/**
 * Traffic-signal coordinates along the active route. Fetches the first window
 * when the route is set (or replaced on reroute) and advances the window as the
 * driver nears its end, accumulating signals. The icon layer is the only
 * consumer, so the data lives here rather than in the global nav store.
 */
export function useNavTrafficSignals(): LngLat[] {
  const route = useNavigationStore((s) => s.route);
  const alongMeters = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const mode = useNavigationStore((s) => s.mode);

  const [signals, setSignals] = useState<LngLat[]>([]);
  const windowRef = useRef({ nextStart: 0, endMeters: 0, done: true });
  const fetchingRef = useRef(false);
  // Bumped on every route change so a fetch still in flight from the previous
  // route can't apply its (now stale) signals to the new one.
  const genRef = useRef(0);

  // Cumulative distances along the route, computed once per route and reused by
  // every window advance so we never re-walk the full geometry per fix.
  const cum = useMemo(() => (route ? cumulativeDistances(route.geometry) : []), [route]);

  // Reset + fetch the first window whenever the active route changes (fresh
  // start or applied reroute). Clears when there is no usable route.
  useEffect(() => {
    genRef.current += 1;
    fetchingRef.current = false;
    if (!route || route.geometry.length < 2) {
      setSignals([]);
      windowRef.current = { nextStart: 0, endMeters: 0, done: true };
      return;
    }
    const gen = genRef.current;
    const w = windowGeometry(route.geometry, 0, MAX_TRACE_POINTS, cum);
    windowRef.current = { nextStart: w.nextStart, endMeters: w.endMeters, done: w.done };
    fetchingRef.current = true;
    fetchTrafficSignals(w.trace, mode)
      .then((found) => {
        if (genRef.current === gen) setSignals(found);
      })
      .finally(() => {
        // Only release the lock if this is still the active generation; a stale
        // previous-route fetch must not clear the new route's in-flight flag.
        if (genRef.current === gen) fetchingRef.current = false;
      });
  }, [route, mode, cum]);

  // Advance the window as the driver nears its far edge (long routes only).
  useEffect(() => {
    if (!route || windowRef.current.done || fetchingRef.current) return;
    if (alongMeters < windowRef.current.endMeters - PREFETCH_METERS) return;
    fetchingRef.current = true;
    const gen = genRef.current;
    // Advance the window ref BEFORE the async fetch so a segment with no signals
    // still moves us forward (or to done) and can't re-trigger this effect on
    // every fix.
    const w = windowGeometry(route.geometry, windowRef.current.nextStart, MAX_TRACE_POINTS, cum);
    windowRef.current = { nextStart: w.nextStart, endMeters: w.endMeters, done: w.done };
    fetchTrafficSignals(w.trace, mode)
      .then((found) => {
        if (genRef.current !== gen || found.length === 0) return;
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
      .finally(() => {
        if (genRef.current === gen) fetchingRef.current = false;
      });
  }, [alongMeters, route, mode, cum]);

  return signals;
}
