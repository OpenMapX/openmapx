import {
  type FixInput,
  fetchDirections,
  formatSpokenDistance,
  type NavTickState,
  navOptionsForMode,
  pickSpeedLimit,
  processFix,
  remainingWaypoints,
  useNavigationStore,
  useSettingsStore,
  VOICE_TIMING_MULTIPLIER,
  type VoiceCue,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";
import { useNavRecordingStore } from "./navRecordingStore";
import { useNavSimStore } from "./navSimStore";
import { useNavigationVoice } from "./useNavigationVoice";
import { useNavRecorder } from "./useNavRecorder";
import { useReplayPosition } from "./useReplayPosition";
import { useSimulatedPosition } from "./useSimulatedPosition";

const freshTick = (): NavTickState => ({
  offRouteScore: 0,
  lastRerouteAtMs: null,
  rerouteBackoffMs: 0,
  spokenCues: [],
});

/** Wires GPS fixes → processFix → navigationStore + side effects (voice, reroute). */
export function useNavigationEngine(): void {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);

  const tickRef = useRef<NavTickState>(freshTick());
  const reroutingRef = useRef(false);
  const captureFix = useNavRecorder();

  const speakCue = useCallback(
    (cue: VoiceCue) => {
      // Prefer the engine's voice-optimized phrasing (Valhalla `verbal_*`): the
      // "now" cue uses the pre-transition line, earlier cues the advance alert.
      // Fall back to the on-screen instruction for engines that omit them.
      const step = cue.step;
      const spoken =
        cue.tier === "now"
          ? (step.verbalPre ?? step.instruction)
          : (step.verbalAlert ?? step.verbalPre ?? step.instruction);
      const units = useSettingsStore.getState().units;
      const distanceStr = formatSpokenDistance(cue.distance, units);
      const text =
        cue.tier === "now"
          ? spoken
          : t("voiceUpcoming", { distance: distanceStr, instruction: spoken });
      speak(text);
    },
    [speak, t],
  );

  const onFix = useCallback(
    (fix: FixInput) => {
      const store = useNavigationStore.getState();
      const { status, route, mode, destinationWaypoints, voiceEnabled } = store;
      if ((status !== "navigating" && status !== "rerouting") || !route) return;

      // Capture the raw fix stream for the recorder (no-op unless recording).
      captureFix(fix, route, mode);

      const opts = navOptionsForMode(mode);
      // Shift voice-cue timing earlier/later per the user's preference.
      opts.announceMultiplier =
        VOICE_TIMING_MULTIPLIER[useSettingsStore.getState().voiceGuidanceTiming];
      const result = processFix(route, fix, tickRef.current, opts);
      tickRef.current = result.nextState;
      // Surface noisy GPS: fixes dropped for poor accuracy flag "Weak GPS"; a
      // usable fix clears it. (Dropping them also suppresses false off-route.)
      if (!result.progress) {
        if (result.accuracyRejected) store.setWeakGps(true);
        return;
      }
      store.setWeakGps(result.weakGps);

      store.applyProgress(result.progress);
      store.setOffRoute(result.offRoute);

      // Speed limit (driving only): read the limit for the segment the user is
      // on straight from the route. OSRM carries per-segment limits on the route
      // (`segmentSpeedLimits`); Valhalla's are accumulated up front into
      // `liveSpeedLimits` by the windowed map-match — both indexed by the snap's
      // segment, so no per-fix lookup. The per-step `speedLimit` is the final
      // fallback. Walking/cycling clear the badge.
      if (mode === "driving") {
        const segIdx = result.progress.segmentIndex;
        store.setSpeedLimit(
          pickSpeedLimit(
            route.segmentSpeedLimits?.[segIdx],
            store.liveSpeedLimits?.[segIdx],
            route.steps[result.progress.currentStepIndex]?.speedLimit,
          ),
        );
      } else {
        store.setSpeedLimit(null);
      }

      if (result.arrived) {
        haptics.success();
        store.completeArrival();
        return;
      }

      if (voiceEnabled && result.voiceCue) speakCue(result.voiceCue);

      // Skip live rerouting while replaying a recording — playback applies the
      // recorded reroutes instead, so the engine must not fetch new routes.
      if (
        result.needsReroute &&
        !reroutingRef.current &&
        !useNavRecordingStore.getState().replaying
      ) {
        reroutingRef.current = true;
        haptics.warn();
        store.beginReroute();
        const from = result.progress.snapped;
        // Re-anchor at the current position and drop intermediate stops already
        // behind us, so a multi-stop reroute doesn't route back to a passed stop.
        const waypoints = remainingWaypoints(
          route.geometry,
          destinationWaypoints,
          from,
          result.progress.alongMeters,
        );
        fetchDirections({ waypoints, mode, lang: locale })
          .then((res) => {
            // Bail out if navigation ended (stopped or arrived) while the
            // reroute was in flight — otherwise we'd resurrect a finished trip.
            const st = useNavigationStore.getState().status;
            if (st === "idle" || st === "arrived") return;
            const next = res.routes?.[res.activeRouteIndex ?? 0];
            if (next) {
              tickRef.current = freshTick();
              useNavigationStore.getState().applyReroute(next);
            } else {
              // No alternative found: stay on the old route and tell the user.
              useNavigationStore.setState({ status: "navigating" });
              useNavigationStore.getState().signalRerouteFailed();
            }
          })
          .catch(() => {
            const st = useNavigationStore.getState().status;
            if (st === "idle" || st === "arrived") return;
            // Offline / API error: keep the old route, surface a toast; the next
            // qualifying off-route fix will retry.
            useNavigationStore.setState({ status: "navigating" });
            useNavigationStore.getState().signalRerouteFailed();
          })
          .finally(() => {
            reroutingRef.current = false;
          });
      }
    },
    [locale, speakCue, captureFix],
  );

  // Reset per-session tick state (spoken cues + deviation history) whenever the
  // active route changes — a fresh start or an applied reroute — so a second
  // navigation session doesn't inherit the previous one's spoken-cue keys.
  const activeRoute = useNavigationStore((s) => s.route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on route identity, not tickRef.
  useEffect(() => {
    tickRef.current = freshTick();
  }, [activeRoute]);

  // Opt into the navigation simulator from the URL (`?navsim=1`) once on mount.
  // It swaps synthetic fixes for real geolocation so the full pipeline can be
  // QA'd without driving; off by default and never reachable in normal use.
  const setSimEnabled = useNavSimStore((s) => s.setEnabled);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("navsim") === "1") setSimEnabled(true);
  }, [setSimEnabled]);

  const active = useNavigationStore((s) => s.status !== "idle" && s.status !== "arrived");
  const simEnabled = useNavSimStore((s) => s.enabled);
  const replaying = useNavRecordingStore((s) => s.replaying);
  // Exactly one position source is live: a replayed recording, the simulator's
  // synthetic fixes, or real geolocation. All hooks are always called; the
  // inactive ones are no-ops.
  useWatchPosition(active && !simEnabled && !replaying, onFix);
  useSimulatedPosition(active && !replaying, onFix);
  useReplayPosition(onFix);
}
