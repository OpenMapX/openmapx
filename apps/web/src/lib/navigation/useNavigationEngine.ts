import {
  type FixInput,
  fetchDirections,
  fetchSpeedLimit,
  formatMeasurementDistance,
  type LngLat,
  type NavTickState,
  navOptionsForMode,
  processFix,
  useNavigationStore,
  useSettingsStore,
  type VoiceCue,
} from "@openmapx/core";
import along from "@turf/along";
import { lineString } from "@turf/helpers";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
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
  const lastSpeedFetchRef = useRef(0);

  const speakCue = useCallback(
    (cue: VoiceCue) => {
      const instruction = cue.step.instruction;
      const units = useSettingsStore.getState().units;
      const distanceStr = formatMeasurementDistance(cue.distance, units);
      const text =
        cue.tier === "now"
          ? instruction
          : t("voiceUpcoming", { distance: distanceStr, instruction });
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
      // Surface noisy GPS: fixes dropped for poor accuracy flag "Weak GPS"; a
      // usable fix clears it. (Dropping them also suppresses false off-route.)
      if (!result.progress) {
        if (result.accuracyRejected) store.setWeakGps(true);
        return;
      }
      store.setWeakGps(false);

      store.applyProgress(result.progress);
      store.setOffRoute(result.offRoute);

      // Speed limit: OSRM populates per-step speedLimit, so prefer that. When
      // the route lacks it (Valhalla steps carry none), fall back to a
      // throttled live map-match lookup while driving; walking/cycling clear
      // the badge.
      const staticLimit = route.steps[result.progress.currentStepIndex]?.speedLimit ?? null;
      if (staticLimit !== null) {
        store.setSpeedLimit(staticLimit);
      } else if (mode === "driving") {
        if (fix.timestampMs - lastSpeedFetchRef.current >= 5000) {
          lastSpeedFetchRef.current = fix.timestampMs;
          // Build a 2-point trace from the snapped position to a point ~25m
          // ahead along the route so the matcher snaps to the road we're on.
          const line = lineString(route.geometry);
          const ahead = along(line, (result.progress.alongMeters + 25) / 1000, {
            units: "kilometers",
          }).geometry.coordinates as LngLat;
          const trace: LngLat[] = [result.progress.snapped, ahead];
          fetchSpeedLimit(trace, "driving")
            .then((limit) => {
              // Ignore if navigation ended while the lookup was in flight.
              const st = useNavigationStore.getState().status;
              if (st === "idle" || st === "arrived") return;
              useNavigationStore.getState().setSpeedLimit(limit);
            })
            // A failed lookup just leaves the badge as-is; never let it surface
            // as an unhandled rejection.
            .catch(() => {});
        }
      } else {
        store.setSpeedLimit(null);
      }

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
    [locale, speakCue],
  );

  // Reset per-session tick state (spoken cues + deviation history) whenever the
  // active route changes — a fresh start or an applied reroute — so a second
  // navigation session doesn't inherit the previous one's spoken-cue keys.
  const activeRoute = useNavigationStore((s) => s.route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on route identity, not tickRef.
  useEffect(() => {
    tickRef.current = freshTick();
  }, [activeRoute]);

  const active = useNavigationStore((s) => s.status !== "idle" && s.status !== "arrived");
  useWatchPosition(active, onFix);
}
