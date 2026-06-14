"use client";

import { type FixInput, simulatePositions, useNavigationStore } from "@openmapx/core";
import { useEffect, useMemo, useRef } from "react";
import { SIM_INTERVAL_MS, useNavSimStore } from "./navSimStore";

/**
 * Drop-in replacement for {@link useWatchPosition} that replays synthetic GPS
 * fixes along the active route instead of reading the device. Feeds the SAME
 * `onFix` the real engine uses, so the entire pipeline (snap, progress, voice,
 * off-route, reroute, speed limit) runs unchanged.
 *
 * Fixes are regenerated whenever the route changes — including after a reroute,
 * which begins at the current position, so playback continues seamlessly from
 * the start of the new geometry. With the off-route offset on, every fix sits
 * laterally off the line, so a reroute fires, applies, and (still offset)
 * re-trips — a continuous reroute-stress loop until the offset is cleared.
 */
export function useSimulatedPosition(active: boolean, onFix: (fix: FixInput) => void): void {
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  const route = useNavigationStore((s) => s.route);
  const enabled = useNavSimStore((s) => s.enabled);
  const speedMps = useNavSimStore((s) => s.speedMps);
  const playbackRate = useNavSimStore((s) => s.playbackRate);
  const offsetMeters = useNavSimStore((s) => s.offsetMeters);

  const idxRef = useRef(0);

  const fixes = useMemo(() => {
    if (!active || !enabled || !route || route.geometry.length < 2) return null;
    return simulatePositions(route.geometry, {
      speedMps,
      intervalMs: SIM_INTERVAL_MS,
      offsetMeters,
    });
  }, [active, enabled, route, speedMps, offsetMeters]);

  // Restart playback from the top when the fix set changes (new route / speed /
  // offset) — but NOT when only the playback rate changes (handled below).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the fix set identity.
  useEffect(() => {
    idxRef.current = 0;
  }, [fixes]);

  useEffect(() => {
    if (!fixes) return;
    const id = setInterval(
      () => {
        if (idxRef.current >= fixes.length) {
          clearInterval(id);
          return;
        }
        onFixRef.current(fixes[idxRef.current++]);
      },
      Math.max(50, SIM_INTERVAL_MS / playbackRate),
    );
    return () => clearInterval(id);
  }, [fixes, playbackRate]);
}
