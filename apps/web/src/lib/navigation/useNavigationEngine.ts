import {
  cumulativeDistances,
  type FixInput,
  fetchDirections,
  type LngLat,
  type NavigationRouteOptions,
  type NavTickState,
  navOptionsForMode,
  type PreparedRouteMatcher,
  prepareRouteMatcher,
  processFix,
  type Route,
  remainingWaypoints,
  shouldRerouteForClosure,
  type TravelMode,
  useNavigationStore,
  useSettingsStore,
  type VoiceCue,
} from "@openmapx/core";
import {
  COAST_TICK_MS,
  canRequestReroute,
  coastedFix,
  EMPTY_REROUTE_CHURN,
  groundSpeedLimit,
  IDLE_REROUTE,
  mayCoast,
  onRerouteFailed,
  onRerouteRequested,
  onRerouteRetryRequested,
  onRerouteSucceeded,
  type RerouteChurn,
  type RerouteRuntime,
  recordRerouteSuccess,
  rerouteCandidate,
  spokenInstructionFor,
  VOICE_TIMING_MULTIPLIER,
} from "@openmapx/core/navigation";
import { formatNavigationCue, NavigationCueError, resolveLocale } from "@openmapx/i18n";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { useLocale } from "next-intl";
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

// When to reroute, which route to follow, how cues are timed, which speed limit
// shows and how the position coasts through a gap in fixes are the shared
// ground session policy, which the installed app's native session follows too.

interface RerouteExecutionRequest {
  trigger: "off-route" | "closure";
  route: Route;
  matcher: PreparedRouteMatcher;
  origin: LngLat;
  alongMeters: number;
  destinationWaypoints: LngLat[];
  mode: TravelMode;
  routeOptions: NavigationRouteOptions;
}

/** Wires GPS fixes → processFix → navigationStore + side effects (voice, reroute). */
export function useNavigationEngine(incidentResource: NavIncidentResource): void {
  const locale = useLocale();
  const speak = useNavigationVoice(locale);

  const tickRef = useRef<NavTickState>(freshTick());
  // The reroute in flight or held back, and the recent successes the churn
  // guard counts.
  const rerouteRef = useRef<RerouteRuntime>(IDLE_REROUTE);
  const churnRef = useRef<RerouteChurn>(EMPTY_REROUTE_CHURN);
  const rerouteAttemptRef = useRef(0);
  const mountedRef = useRef(false);
  const lastHandledRetryNonceRef = useRef(0);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rerouteAttemptRef.current++;
      rerouteRef.current = IDLE_REROUTE;
      if (useNavigationStore.getState().status === "rerouting") {
        useNavigationStore.setState({ status: "navigating" });
      }
    };
  }, []);

  const executeReroute = useCallback(
    (request: RerouteExecutionRequest): boolean => {
      const now = Date.now();
      const decision = canRequestReroute(
        rerouteRef.current,
        churnRef.current,
        useNavigationStore.getState().connectivity,
        now,
      );
      if (!decision.allow) return false;

      const attempt = ++rerouteAttemptRef.current;
      const requestId = String(attempt);
      const navigationStartedAtMs = useNavigationStore.getState().navigationStartedAtMs;
      const isCurrentAttempt = () => {
        const state = useNavigationStore.getState();
        return (
          mountedRef.current &&
          rerouteAttemptRef.current === attempt &&
          state.navigationStartedAtMs === navigationStartedAtMs &&
          state.route === request.route &&
          state.status !== "idle" &&
          state.status !== "arrived"
        );
      };

      rerouteRef.current = onRerouteRequested(rerouteRef.current, requestId, now);
      haptics.warn();
      useNavigationStore.getState().beginReroute();
      const waypoints = remainingWaypoints(
        request.matcher,
        request.destinationWaypoints,
        request.origin,
        request.alongMeters,
      );
      fetchDirections({
        waypoints,
        mode: request.mode,
        lang: locale,
        ...request.routeOptions,
        ...(request.trigger === "closure" ? { avoidClosures: true } : {}),
      })
        .then((response) => {
          if (!isCurrentAttempt()) return;
          const next = rerouteCandidate(response);
          if (!next) {
            rerouteRef.current = onRerouteFailed(
              rerouteRef.current,
              "no-route",
              Date.now(),
              Math.random(),
            );
            useNavigationStore.setState({ status: "navigating" });
            useNavigationStore.getState().signalRerouteFailed();
            return;
          }

          rerouteRef.current = onRerouteSucceeded();
          churnRef.current = recordRerouteSuccess(churnRef.current, Date.now());
          tickRef.current = freshTick();
          useNavigationStore
            .getState()
            .applyReroute(
              next,
              response.provider,
              undefined,
              response.roadConditionImpact,
              waypoints,
            );
        })
        .catch((error) => {
          if (!isCurrentAttempt()) return;
          useNavigationStore.setState({ status: "navigating" });
          const connectivityFailure = isConnectivityFailure(
            error,
            useNavigationStore.getState().connectivity,
          );
          rerouteRef.current = onRerouteFailed(
            rerouteRef.current,
            connectivityFailure ? "network" : "request-failed",
            Date.now(),
            Math.random(),
          );
          if (connectivityFailure) useNavigationStore.getState().setRerouteUnavailable(true);
          useNavigationStore.getState().signalRerouteFailed();
        })
        .finally(() => {
          // An answer nobody applied (the trip ended or its route was replaced)
          // leaves no request open.
          const runtime = rerouteRef.current;
          if (runtime.status === "in-flight" && runtime.requestId === requestId) {
            rerouteRef.current = { status: "idle", attempts: runtime.attempts };
          }
        });
      return true;
    },
    [locale],
  );

  const speakCue = useCallback(
    (cue: VoiceCue) => {
      const instruction = spokenInstructionFor(cue);
      if (!instruction) return;
      let text: string;
      try {
        text = formatNavigationCue(
          { kind: "ground-maneuver", tier: cue.tier, instruction, distanceMeters: cue.distance },
          resolveLocale(locale),
          { units: useSettingsStore.getState().units },
        );
      } catch (error) {
        // An unusable instruction costs one cue, not navigation progression.
        if (error instanceof NavigationCueError) return;
        throw error;
      }
      speak(text);
    },
    [speak, locale],
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

      // OSRM carries per-segment limits on the route (`segmentSpeedLimits`);
      // Valhalla's are accumulated up front into `liveSpeedLimits` by the
      // windowed map-match. Both are indexed by the snap's segment.
      const currentSpeedLimit = groundSpeedLimit({
        mode,
        route,
        liveSpeedLimits: store.liveSpeedLimits,
        segmentIndex: result.progress.segmentIndex,
        stepIndex: result.progress.currentStepIndex,
      });

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
      if (result.needsReroute && canAttemptReroute && !useNavRecordingStore.getState().replaying) {
        if (retryRequested) rerouteRef.current = onRerouteRetryRequested(rerouteRef.current);
        // Re-anchor at the actual GPS position. The progress position is snapped
        // onto the obsolete route; using it here would ask the router for the
        // same route again and leave a genuinely off-route traveller stranded in
        // a reroute → waiting-for-GPS loop. Keep the old route projection only
        // for deciding which intermediate stops are already behind us.
        const started = executeReroute({
          trigger: "off-route",
          route,
          matcher,
          origin: fix.coords,
          alongMeters: result.progress.alongMeters,
          destinationWaypoints,
          mode,
          routeOptions,
        });
        if (started && retryRequested) lastHandledRetryNonceRef.current = rerouteRetryNonce;
      }
    },
    [speakCue, captureFix, matcherFor, executeReroute],
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
      rerouteAttemptRef.current++;
      rerouteRef.current = IDLE_REROUTE;
      churnRef.current = EMPTY_REROUTE_CHURN;
      lastRealFixRef.current = null;
      cumRef.current = null;
      matcherRef.current = null;
    }
  }, [navStatus]);

  // Closure-ahead reroute: when avoidIncidents is on, a new situation that
  // closes the road to cars, projected ahead of the driver (not known at
  // route-commit time), triggers an
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
      (a) => a.closesRoad && !knownClosureIdsRef.current.has(a.id),
    );
    const tick = tickRef.current;
    const backoffMs = tick.rerouteBackoffMs || 3_000;
    const fire = shouldRerouteForClosure(
      newClosureAhead,
      tick.lastRerouteAtMs,
      backoffMs,
      Date.now(),
    );
    if (!fire) return;
    const store = useNavigationStore.getState();
    const { route, mode, destinationWaypoints, progress, routeOptions } = store;
    if (store.connectivity === "offline" || store.rerouteUnavailable) {
      if (store.connectivity === "offline") store.setRerouteUnavailable(true);
      return;
    }
    if (!route || !progress) return;
    executeReroute({
      trigger: "closure",
      route,
      matcher: matcherFor(route.geometry),
      origin: progress.snapped,
      alongMeters: progress.alongMeters,
      destinationWaypoints,
      mode,
      routeOptions,
    });
  }, [incidents, incidentStatus, avoidIncidents, navStatus, matcherFor, executeReroute]);

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
  // re-anchors it (above). Runs only while navigating on the route, and stops
  // where the estimate runs out.
  useEffect(() => {
    if (!active || simEnabled || replaying) return;
    const id = window.setInterval(() => {
      const store = useNavigationStore.getState();
      const route = store.route;
      const last = lastRealFixRef.current;
      if (store.status !== "navigating" || !route || !last) return;
      if (!mayCoast({ offRoute: store.offRoute, rerouting: false, speedMps: last.speedMps })) {
        return;
      }
      if (cumRef.current?.route !== route) {
        cumRef.current = { route, cum: cumulativeDistances(route.geometry) };
      }
      const fix = coastedFix(last, route.geometry, cumRef.current.cum, Date.now());
      if (!fix) return;
      store.setCoasting(true);
      onFix(fix);
    }, COAST_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, simEnabled, replaying, onFix]);
}
