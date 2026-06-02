import {
  type FixInput,
  fetchDirections,
  type NavTickState,
  navOptionsForMode,
  processFix,
  useNavigationStore,
  type VoiceCue,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useRef } from "react";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";
import { useNavigationVoice } from "./useNavigationVoice";

const freshTick = (): NavTickState => ({
  deviationHistory: [],
  lastRerouteAtMs: null,
  spokenCues: [],
});

/** Wires GPS fixes → processFix → navigationStore + side effects (voice, reroute). */
export function useNavigationEngine(): void {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);

  const tickRef = useRef<NavTickState>(freshTick());
  const reroutingRef = useRef(false);

  const speakCue = useCallback(
    (cue: VoiceCue) => {
      const instruction = cue.step.instruction;
      const text =
        cue.tier === "now"
          ? instruction
          : t("voiceUpcoming", { distance: Math.round(cue.distance), instruction });
      speak(text);
    },
    [speak, t],
  );

  const onFix = useCallback(
    (fix: FixInput) => {
      const store = useNavigationStore.getState();
      const { status, route, mode, destinationWaypoints, voiceEnabled } = store;
      if ((status !== "navigating" && status !== "rerouting") || !route) return;

      const opts = navOptionsForMode(mode);
      const result = processFix(route, fix, tickRef.current, opts);
      tickRef.current = result.nextState;
      if (!result.progress) return;

      store.applyProgress(result.progress);
      store.setOffRoute(result.offRoute);
      // Surface the current step's speed limit (OSRM populates step.speedLimit;
      // unknown steps clear the badge).
      store.setSpeedLimit(route.steps[result.progress.currentStepIndex]?.speedLimit ?? null);

      if (result.arrived) {
        haptics.success();
        store.completeArrival();
        return;
      }

      if (voiceEnabled && result.voiceCue) speakCue(result.voiceCue);

      if (result.needsReroute && !reroutingRef.current) {
        reroutingRef.current = true;
        haptics.warn();
        store.beginReroute();
        const from = result.progress.snapped;
        // NOTE: keeps all original waypoints except the origin. For multi-stop
        // routes this can re-include already-passed intermediate stops on
        // reroute; precise waypoint-progress tracking is a future refinement.
        const waypoints = [from, ...destinationWaypoints.slice(1)];
        fetchDirections({ waypoints, mode, lang: locale })
          .then((res) => {
            // Bail out if navigation was stopped while the reroute was in flight.
            if (useNavigationStore.getState().status === "idle") return;
            const next = res.routes?.[res.activeRouteIndex ?? 0];
            if (next) {
              tickRef.current = freshTick();
              useNavigationStore.getState().applyReroute(next);
            } else {
              useNavigationStore.setState({ status: "navigating" });
            }
          })
          .catch(() => {
            if (useNavigationStore.getState().status === "idle") return;
            useNavigationStore.setState({ status: "navigating" });
          })
          .finally(() => {
            reroutingRef.current = false;
          });
      }
    },
    [locale, speakCue],
  );

  const active = useNavigationStore((s) => s.status !== "idle" && s.status !== "arrived");
  useWatchPosition(active, onFix);
}
