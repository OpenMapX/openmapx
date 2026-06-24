import {
  type FixInput,
  fetchDirections,
  formatSpokenDistance,
  isReroutingTooOften,
  type NavTickState,
  navOptionsForMode,
  pickSpeedLimit,
  processFix,
  pruneRerouteTimes,
  remainingWaypoints,
  shouldRerouteForClosure,
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
import { useNavIncidents } from "./useNavIncidents";
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

// Churn guard: when reroutes fire too often (the fresh route keeps reading
// off-route from GPS noise / an awkward first maneuver), pause rerouting briefly
// so the recomputed route can settle instead of churning on every fix.
const REROUTE_CHURN_WINDOW_MS = 120_000; // 2 min
const REROUTE_CHURN_MAX = 3; // reroutes within the window that trip the cooldown
const REROUTE_CHURN_COOLDOWN_MS = 30_000;

/** Wires GPS fixes → processFix → navigationStore + side effects (voice, reroute). */
export function useNavigationEngine(): void {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);

  const tickRef = useRef<NavTickState>(freshTick());
  const reroutingRef = useRef(false);
  // Recent successful-reroute times (ms) + cooldown deadline for the churn guard.
  const rerouteTimesRef = useRef<number[]>([]);
  const rerouteCooldownUntilRef = useRef(0);
  // Closure ids present at the time the first road-conditions fetch for the
  // committed route resolved (the baseline). Only incidents whose id is NOT in
  // this set are treated as "new" and trigger a reroute.
  const knownClosureIdsRef = useRef<Set<string>>(new Set());
  // True once the baseline has been captured from the route's first fetch result.
  // Resets on route change so we don't fire against stale/empty state.
  const baselineReadyRef = useRef(false);
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
        !useNavRecordingStore.getState().replaying &&
        Date.now() >= rerouteCooldownUntilRef.current
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
        fetchDirections({
          waypoints,
          mode,
          lang: locale,
          avoidClosures: useSettingsStore.getState().avoidIncidents,
        })
          .then((res) => {
            // Bail out if navigation ended (stopped or arrived) while the
            // reroute was in flight — otherwise we'd resurrect a finished trip.
            const st = useNavigationStore.getState().status;
            if (st === "idle" || st === "arrived") return;
            const next = res.routes?.[res.activeRouteIndex ?? 0];
            if (next) {
              // Churn guard: record this reroute; if too many fired recently,
              // pause further reroutes so the fresh route can settle.
              const now = Date.now();
              rerouteTimesRef.current = pruneRerouteTimes(
                [...rerouteTimesRef.current, now],
                now,
                REROUTE_CHURN_WINDOW_MS,
              );
              if (isReroutingTooOften(rerouteTimesRef.current, REROUTE_CHURN_MAX)) {
                rerouteCooldownUntilRef.current = now + REROUTE_CHURN_COOLDOWN_MS;
                rerouteTimesRef.current = [];
              }
              tickRef.current = freshTick();
              useNavigationStore.getState().applyReroute(next, res.provider);
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
  const { incidents, ready } = useNavIncidents();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on route identity, not tickRef.
  useEffect(() => {
    tickRef.current = freshTick();
    knownClosureIdsRef.current = new Set();
    baselineReadyRef.current = false;
  }, [activeRoute]);

  // Capture the closure baseline only once the first road-conditions fetch for
  // the committed route has resolved. This prevents pre-fetch state (an empty or
  // stale snapshot) from being mistaken for "no closures", which would make every
  // closure that arrives with the first response look "new" and trigger a spurious
  // reroute at navigation start.
  useEffect(() => {
    if (!ready || baselineReadyRef.current) return;
    knownClosureIdsRef.current = new Set(incidents.map((a) => a.id));
    baselineReadyRef.current = true;
  }, [ready, incidents]);

  // Clear the churn guard when navigation ends so a new session starts clean.
  const navStatus = useNavigationStore((s) => s.status);
  useEffect(() => {
    if (navStatus === "idle") {
      rerouteTimesRef.current = [];
      rerouteCooldownUntilRef.current = 0;
    }
  }, [navStatus]);

  // Closure-ahead reroute: when avoidIncidents is on, a new road/lane closure
  // projected ahead of the driver (not known at route-commit time) triggers an
  // automatic reroute. Uses the same backoff + churn guard as off-route reroutes.
  // Gated on baselineReadyRef so we never fire before the first fetch resolves —
  // closures present when the route was planned are always part of the baseline.
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  useEffect(() => {
    if (!avoidIncidents) return;
    if (navStatus !== "navigating") return;
    if (!baselineReadyRef.current) return;
    const newClosureAhead = incidents.some(
      (a) =>
        (a.eventType === "road_closure" || a.eventType === "lane_closure") &&
        !knownClosureIdsRef.current.has(a.id),
    );
    const tick = tickRef.current;
    const backoffMs = tick.rerouteBackoffMs || 3_000;
    const fire = shouldRerouteForClosure(
      newClosureAhead,
      tick.lastRerouteAtMs,
      backoffMs,
      Date.now(),
    );
    if (!fire || reroutingRef.current || Date.now() < rerouteCooldownUntilRef.current) return;
    const store = useNavigationStore.getState();
    const { route, mode, destinationWaypoints, progress } = store;
    if (!route || !progress) return;
    reroutingRef.current = true;
    haptics.warn();
    store.beginReroute();
    const from = progress.snapped;
    const waypoints = remainingWaypoints(
      route.geometry,
      destinationWaypoints,
      from,
      progress.alongMeters,
    );
    fetchDirections({ waypoints, mode, lang: locale, avoidClosures: true })
      .then((res) => {
        const st = useNavigationStore.getState().status;
        if (st === "idle" || st === "arrived") return;
        const next = res.routes?.[res.activeRouteIndex ?? 0];
        if (next) {
          const now = Date.now();
          rerouteTimesRef.current = pruneRerouteTimes(
            [...rerouteTimesRef.current, now],
            now,
            REROUTE_CHURN_WINDOW_MS,
          );
          if (isReroutingTooOften(rerouteTimesRef.current, REROUTE_CHURN_MAX)) {
            rerouteCooldownUntilRef.current = now + REROUTE_CHURN_COOLDOWN_MS;
            rerouteTimesRef.current = [];
          }
          tickRef.current = freshTick();
          useNavigationStore.getState().applyReroute(next, res.provider);
        } else {
          useNavigationStore.setState({ status: "navigating" });
          useNavigationStore.getState().signalRerouteFailed();
        }
      })
      .catch(() => {
        const st = useNavigationStore.getState().status;
        if (st === "idle" || st === "arrived") return;
        useNavigationStore.setState({ status: "navigating" });
        useNavigationStore.getState().signalRerouteFailed();
      })
      .finally(() => {
        reroutingRef.current = false;
      });
  }, [incidents, avoidIncidents, navStatus, locale]);

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
