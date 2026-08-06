import {
  coastState,
  cumulativeDistances,
  type FixInput,
  fetchDirections,
  formatSpokenDistance,
  isReroutingTooOften,
  type LngLat,
  type NavTickState,
  navOptionsForMode,
  type PreparedRouteMatcher,
  pickSpeedLimit,
  positionAt,
  prepareRouteMatcher,
  processFix,
  pruneRerouteTimes,
  type Route,
  remainingWaypoints,
  shouldRerouteForClosure,
  useNavigationStore,
  useSettingsStore,
  VOICE_TIMING_MULTIPLIER,
  type VoiceCue,
} from "@openmapx/core";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";
import { isConnectivityFailure } from "./navigationConnectivity";
import { useNavRecordingStore } from "./navRecordingStore";
import { useNavSimStore } from "./navSimStore";
import { useFasterRoute } from "./useFasterRoute";
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

// Coasting: when real fixes stop (tunnel, garage, urban canyon), extrapolate the
// position along the route instead of freezing at the outage point. Start after
// a few fix-less seconds, decelerate to a stop over ~2 min, and never coast more
// than ~3 km — a straight-tunnel estimate degrades gracefully rather than lying.
const COAST_START_MS = 3000;
const COAST_MAX_MS = 120_000;
const COAST_MAX_METERS = 3000;
const COAST_TICK_MS = 250;

/** Wires GPS fixes → processFix → navigationStore + side effects (voice, reroute). */
export function useNavigationEngine(incidentResource: NavIncidentResource): void {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);

  const tickRef = useRef<NavTickState>(freshTick());
  const reroutingRef = useRef(false);
  const lastHandledRetryNonceRef = useRef(0);
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
  // The last `successfulRevision` this engine has already reacted to, so a
  // revision that hasn't changed (status flipping between renders without a new
  // fetch resolving) never re-runs the arm-or-detect step. Resets on route
  // change alongside `baselineReadyRef` — otherwise a coincidental revision
  // number collision with the previous route could skip arming the new one.
  const lastSeenRevisionRef = useRef(0);
  const captureFix = useNavRecorder();
  // Last accepted *real* fix, for the coasting driver: its arc-length and speed
  // anchor the extrapolation, its timestamp measures the outage.
  const lastRealFixRef = useRef<{ atMs: number; alongMeters: number; speedMps: number } | null>(
    null,
  );
  // Cached cumulative distances for the coasting driver's positionAt lookups.
  const cumRef = useRef<{ route: Route; cum: number[] } | null>(null);
  // The active route's snap index. It belongs to the geometry, not to the fix,
  // so it is built when the route is selected or replaced and reused by every
  // fix, coast tick, and waypoint pruning until then. A ref, because the fix
  // handler reads the route from the store rather than from render state.
  const matcherRef = useRef<PreparedRouteMatcher | null>(null);

  /** The index for `geometry`, building it only when the route was replaced. */
  const matcherFor = useCallback((geometry: LngLat[]): PreparedRouteMatcher => {
    const held = matcherRef.current;
    if (held?.geometry === geometry) return held;
    // Dropping the reference here releases the previous route's index.
    const prepared = prepareRouteMatcher(geometry);
    matcherRef.current = prepared;
    return prepared;
  }, []);

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
      const {
        status,
        route,
        mode,
        destinationWaypoints,
        routeOptions,
        voiceEnabled,
        connectivity,
        rerouteUnavailable,
        rerouteRetryNonce,
      } = store;
      if ((status !== "navigating" && status !== "rerouting") || !route) return;

      // Capture the raw fix stream for the recorder (no-op unless recording).
      // Coasted fixes are synthetic — never record them.
      if (!fix.coasted) captureFix(fix, route, mode);

      const opts = navOptionsForMode(mode);
      // Shift voice-cue timing earlier/later per the user's preference.
      opts.announceMultiplier =
        VOICE_TIMING_MULTIPLIER[useSettingsStore.getState().voiceGuidanceTiming];
      const matcher = matcherFor(route.geometry);
      const result = processFix(route, fix, tickRef.current, opts, matcher);
      tickRef.current = result.nextState;
      // Surface noisy GPS: fixes dropped for poor accuracy flag "Weak GPS"; a
      // usable fix clears it. (Dropping them also suppresses false off-route.)
      // Returning early keeps the last valid progress on screen; the flag is
      // only published when it actually changes, so a run of bad fixes is silent.
      if (!result.progress) {
        if (result.accuracyRejected && !store.weakGps) store.setWeakGps(true);
        return;
      }

      // A real accepted fix re-anchors the coasting driver; the publication
      // below ends any coast that was running.
      if (!fix.coasted) {
        lastRealFixRef.current = {
          atMs: fix.timestampMs,
          alongMeters: result.progress.alongMeters,
          speedMps: result.progress.speedMps,
        };
      }

      // Speed limit (driving only): read the limit for the segment the user is
      // on straight from the route. OSRM carries per-segment limits on the route
      // (`segmentSpeedLimits`); Valhalla's are accumulated up front into
      // `liveSpeedLimits` by the windowed map-match — both indexed by the snap's
      // segment, so no per-fix lookup. The per-step `speedLimit` is the final
      // fallback. Walking/cycling clear the badge.
      const currentSpeedLimit =
        mode === "driving"
          ? pickSpeedLimit(
              route.segmentSpeedLimits?.[result.progress.segmentIndex],
              store.liveSpeedLimits?.[result.progress.segmentIndex],
              route.steps[result.progress.currentStepIndex]?.speedLimit,
            )
          : null;

      // Everything this fix produced describes one instant, so publish it as one
      // store update. A coasted fix leaves `coasting` alone to keep the coast
      // running; a real fix clears it in the same update.
      store.applyGroundFix({
        progress: result.progress,
        weakGps: result.weakGps,
        offRoute: result.offRoute,
        currentSpeedLimit,
        coasting: fix.coasted ? undefined : false,
      });

      if (result.arrived) {
        haptics.success();
        store.completeArrival();
        return;
      }

      if (voiceEnabled && result.voiceCue) speakCue(result.voiceCue);

      // Skip live rerouting while replaying a recording — playback applies the
      // recorded reroutes instead, so the engine must not fetch new routes.
      const retryRequested = rerouteRetryNonce > lastHandledRetryNonceRef.current;
      const canAttemptReroute =
        connectivity === "online" && (!rerouteUnavailable || retryRequested);
      if (result.needsReroute && connectivity === "offline") {
        store.setRerouteUnavailable(true);
      }
      if (
        result.needsReroute &&
        canAttemptReroute &&
        !reroutingRef.current &&
        !useNavRecordingStore.getState().replaying &&
        Date.now() >= rerouteCooldownUntilRef.current
      ) {
        if (retryRequested) lastHandledRetryNonceRef.current = rerouteRetryNonce;
        reroutingRef.current = true;
        haptics.warn();
        store.beginReroute();
        // Re-anchor at the actual GPS position. The progress position is snapped
        // onto the obsolete route; using it here would ask the router for the
        // same route again and leave a genuinely off-route traveller stranded in
        // a reroute → waiting-for-GPS loop. Keep the old route projection only
        // for deciding which intermediate stops are already behind us.
        const waypoints = remainingWaypoints(
          matcher,
          destinationWaypoints,
          fix.coords,
          result.progress.alongMeters,
        );
        fetchDirections({
          waypoints,
          mode,
          lang: locale,
          ...routeOptions,
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
          .catch((error) => {
            const st = useNavigationStore.getState().status;
            if (st === "idle" || st === "arrived") return;
            // Offline / API error: keep the old route, surface a toast; the next
            // qualifying off-route fix will retry.
            useNavigationStore.setState({ status: "navigating" });
            if (isConnectivityFailure(error, useNavigationStore.getState().connectivity)) {
              useNavigationStore.getState().setRerouteUnavailable(true);
            }
            useNavigationStore.getState().signalRerouteFailed();
          })
          .finally(() => {
            reroutingRef.current = false;
          });
      }
    },
    [locale, speakCue, captureFix, matcherFor],
  );

  // Reset per-session tick state (spoken cues + deviation history) whenever the
  // active route changes — a fresh start or an applied reroute — so a second
  // navigation session doesn't inherit the previous one's spoken-cue keys.
  const activeRoute = useNavigationStore((s) => s.route);
  const { incidents, status: incidentStatus, successfulRevision } = incidentResource;
  useFasterRoute();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on route identity, not tickRef.
  useEffect(() => {
    tickRef.current = freshTick();
    knownClosureIdsRef.current = new Set();
    baselineReadyRef.current = false;
    lastSeenRevisionRef.current = 0;
    // The coast anchor's arc-length is relative to the old route; drop it (and
    // any active coast) so we don't extrapolate onto the new geometry.
    lastRealFixRef.current = null;
    // The old geometry's index goes with it; the next fix indexes the new route.
    matcherRef.current = null;
    useNavigationStore.getState().setCoasting(false);
  }, [activeRoute]);

  // Capture the closure baseline only once the first SUCCESSFUL road-conditions
  // fetch for the committed route has resolved — `status === "fresh"` is the
  // only truthful signal of that; a failed or stale revision must never be
  // mistaken for "no closures", which would make every closure that arrives
  // with the real first response look "new" and trigger a spurious reroute at
  // navigation start. Guards on `successfulRevision` so re-renders between
  // fetches (e.g. from `along` ticking) don't re-run this for the same fetch.
  useEffect(() => {
    if (incidentStatus !== "fresh" || successfulRevision === lastSeenRevisionRef.current) return;
    lastSeenRevisionRef.current = successfulRevision;
    if (baselineReadyRef.current) return;
    knownClosureIdsRef.current = new Set(incidents.map((a) => a.id));
    baselineReadyRef.current = true;
  }, [incidentStatus, successfulRevision, incidents]);

  // Clear the churn guard when navigation ends so a new session starts clean.
  const navStatus = useNavigationStore((s) => s.status);
  useEffect(() => {
    if (navStatus === "idle") {
      rerouteTimesRef.current = [];
      rerouteCooldownUntilRef.current = 0;
      lastRealFixRef.current = null;
      cumRef.current = null;
      matcherRef.current = null;
    }
  }, [navStatus]);

  // Closure-ahead reroute: when avoidIncidents is on, a new road/lane closure
  // projected ahead of the driver (not known at route-commit time) triggers an
  // automatic reroute. Uses the same backoff + churn guard as off-route reroutes.
  // Gated on baselineReadyRef so we never fire before the first fetch resolves —
  // closures present when the route was planned are always part of the baseline.
  // Also gated on `status === "fresh"`: a stale or failed revision replays the
  // last-good incident set unchanged, so re-evaluating it is harmless, but it
  // must never be the thing that FLAGS a closure as newly discovered.
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  useEffect(() => {
    if (!avoidIncidents) return;
    if (navStatus !== "navigating") return;
    if (!baselineReadyRef.current) return;
    if (incidentStatus !== "fresh") return;
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
    const { route, mode, destinationWaypoints, progress, routeOptions } = store;
    if (store.connectivity === "offline" || store.rerouteUnavailable) {
      if (store.connectivity === "offline") store.setRerouteUnavailable(true);
      return;
    }
    if (!route || !progress) return;
    reroutingRef.current = true;
    haptics.warn();
    store.beginReroute();
    const from = progress.snapped;
    const waypoints = remainingWaypoints(
      matcherFor(route.geometry),
      destinationWaypoints,
      from,
      progress.alongMeters,
    );
    fetchDirections({ waypoints, mode, lang: locale, ...routeOptions, avoidClosures: true })
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
      .catch((error) => {
        const st = useNavigationStore.getState().status;
        if (st === "idle" || st === "arrived") return;
        useNavigationStore.setState({ status: "navigating" });
        if (isConnectivityFailure(error, useNavigationStore.getState().connectivity)) {
          useNavigationStore.getState().setRerouteUnavailable(true);
        }
        useNavigationStore.getState().signalRerouteFailed();
      })
      .finally(() => {
        reroutingRef.current = false;
      });
  }, [incidents, incidentStatus, avoidIncidents, navStatus, locale, matcherFor]);

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

  // Coasting driver (real GPS only): while fixes are absent, feed the pipeline a
  // synthetic on-route fix at the extrapolated position so the puck, ETA, and
  // voice cues keep advancing through the outage instead of freezing. On-route
  // by construction, so it can never trip an off-route reroute; a real fix
  // re-anchors it (above). Runs only while navigating — not during a reroute.
  useEffect(() => {
    if (!active || simEnabled || replaying) return;
    const id = window.setInterval(() => {
      const store = useNavigationStore.getState();
      const route = store.route;
      const last = lastRealFixRef.current;
      if (store.status !== "navigating" || !route || !last) return;
      const coast = coastState(last.alongMeters, last.speedMps, Date.now() - last.atMs, {
        startAfterMs: COAST_START_MS,
        maxCoastMs: COAST_MAX_MS,
        maxCoastMeters: COAST_MAX_METERS,
        routeLengthMeters: route.distance,
      });
      if (!coast.coasting) return;
      if (cumRef.current?.route !== route) {
        cumRef.current = { route, cum: cumulativeDistances(route.geometry) };
      }
      const { point, bearing } = positionAt(route.geometry, cumRef.current.cum, coast.alongMeters);
      store.setCoasting(true);
      onFix({
        coords: point,
        accuracy: 1,
        heading: bearing,
        speed: coast.speedMps,
        timestampMs: Date.now(),
        coasted: true,
      });
    }, COAST_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, simEnabled, replaying, onFix]);
}
