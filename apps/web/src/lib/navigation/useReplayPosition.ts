"use client";

import { type FixInput, useNavigationStore } from "@openmapx/core";
import { useEffect, useRef } from "react";
import { useNavRecordingStore } from "./navRecordingStore";
import { useNavSimStore } from "./navSimStore";

/**
 * Replay a loaded recording through the live engine: bootstraps a navigation
 * session on the recorded route, then feeds the recorded fixes into the SAME
 * `onFix` at their original pacing (inter-fix wall-clock gaps ÷ playback rate),
 * swapping to each recorded reroute at its boundary. The engine's live reroute
 * is suppressed while replaying (see {@link useNavigationEngine}) so playback
 * follows the recorded routes rather than fetching new ones.
 *
 * Replay is a takeover mode: starting it bootstraps a fresh session on the
 * recorded route (replacing any in-progress sim/real trip — this is a dev/QA
 * tool, so that is intended), and ending it (finished or stopped) tears the
 * session back down so the simulator/geolocation doesn't pick up the recorded
 * route. A drop-in position source like {@link useSimulatedPosition}.
 */
export function useReplayPosition(onFix: (fix: FixInput) => void): void {
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  const replaying = useNavRecordingStore((s) => s.replaying);
  const loaded = useNavRecordingStore((s) => s.loaded);
  const stopReplay = useNavRecordingStore((s) => s.stopReplay);
  const playbackRate = useNavSimStore((s) => s.playbackRate);
  // Read the live playback rate without restarting the feed loop when it changes
  // (otherwise bumping the speed mid-replay would re-bootstrap from fix 0).
  const rateRef = useRef(playbackRate);
  rateRef.current = playbackRate;

  useEffect(() => {
    if (!replaying || !loaded || loaded.fixes.length === 0) return;
    const geometry = loaded.route.geometry;
    if (geometry.length < 2) return;
    const reroutes = loaded.reroutes ?? [];

    // Bootstrap a fresh session on the recorded route. Waypoints only matter for
    // the (suppressed) live reroute, so the geometry endpoints suffice.
    useNavigationStore
      .getState()
      .startGroundNavigation(loaded.route, loaded.mode, [
        geometry[0],
        geometry[geometry.length - 1],
      ]);

    let i = 0;
    let rerouteIdx = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const feed = () => {
      if (cancelled) return;
      if (i >= loaded.fixes.length) {
        stopReplay();
        return;
      }
      // Apply any reroute that takes effect before this fix.
      while (rerouteIdx < reroutes.length && reroutes[rerouteIdx].afterFixCount === i) {
        useNavigationStore.getState().applyReroute(reroutes[rerouteIdx].route);
        rerouteIdx += 1;
      }
      onFixRef.current(loaded.fixes[i]);
      const prevTs = loaded.fixes[i].timestampMs;
      i += 1;
      if (i >= loaded.fixes.length) {
        stopReplay();
        return;
      }
      const gap =
        Math.max(0, loaded.fixes[i].timestampMs - prevTs) / Math.max(0.1, rateRef.current);
      timer = setTimeout(feed, Math.min(gap, 10_000));
    };
    feed();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [replaying, loaded, stopReplay]);

  // When replay ends (finished or stopped via the control), tear down the
  // session it bootstrapped — otherwise it stays `status: "navigating"` and the
  // simulator/geolocation hooks (gated only on `!replaying`) would take over and
  // keep driving the recorded route. Left alone when the recording ended at
  // arrival (status already "arrived"), so the arrival card stays visible.
  const wasReplaying = useRef(false);
  useEffect(() => {
    if (wasReplaying.current && !replaying) {
      if (useNavigationStore.getState().status === "navigating") {
        useNavigationStore.getState().stopNavigation();
      }
    }
    wasReplaying.current = replaying;
  }, [replaying]);
}
