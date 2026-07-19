import type { LngLat } from "../types/geometry";
import type { RouteStep, TravelMode } from "../types/routing";

export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived";
export type CameraMode = "follow" | "free";
export type CueTier = "far" | "near" | "now";

export interface SnapResult {
  snapped: LngLat;
  alongMeters: number;
  deviationMeters: number;
  segmentIndex: number;
}

export interface ProgressResult {
  currentStepIndex: number;
  distanceToNextManeuver: number;
  distanceRemaining: number;
  durationRemaining: number;
}

export interface NavProgress extends ProgressResult {
  snapped: LngLat;
  alongMeters: number;
  deviationMeters: number;
  /**
   * Index of the `route.geometry` segment the snapped position lies on (0-based,
   * up to `geometry.length - 2`). Lets consumers read per-segment route data —
   * e.g. `route.segmentSpeedLimits[segmentIndex]` — for the user's exact spot.
   */
  segmentIndex: number;
  etaEpochMs: number;
  /** Travel direction at the snapped position, degrees clockwise from north. */
  bearing: number;
  /**
   * Ground speed at this fix, m/s. Prefers the GPS-reported speed; falls back to
   * the along-route distance covered since the previous fix. Drives the
   * dead-reckoning follow camera between fixes.
   */
  speedMps: number;
}

export interface RerouteOpts {
  /** Base off-route deviation threshold (m); widened by GPS accuracy at runtime. */
  thresholdMeters: number;
  /** Accrued off-route score at which a reroute fires. */
  scoreThreshold: number;
  /** Initial debounce between reroutes (ms); grows on repeats, resets on route. */
  backoffBaseMs: number;
  /** Upper bound on the reroute debounce (ms). */
  backoffMaxMs: number;
}

/**
 * Speed-adaptive voice-cue scheduling. Each stage fires a fixed time ahead of
 * the maneuver: `farMeters`/`nearMeters` are the trigger distances at
 * `refSpeedMps` and scale UP (never down) with the current speed, so a cue that
 * lands ~400 m before a turn in town lands ~1 km before it on a motorway.
 * `ttsDelaySeconds` pads each trigger so the sentence finishes before the turn.
 */
export interface VoiceScheduleConfig {
  /** "Prepare" (far) cue distance, metres, at/below refSpeedMps. */
  farMeters: number;
  /** "Turn-in" (near) cue distance, metres, at/below refSpeedMps. */
  nearMeters: number;
  /** Speed (m/s) the far/near distances are tuned for; above it they scale up. */
  refSpeedMps: number;
  /** Lead time (s) for the imminent "now" cue. */
  nowSeconds: number;
  /** Floor (m) for the "now" cue so it still fires when nearly stopped. */
  nowFloorMeters: number;
  /** Extra lead (s) per cue covering TTS spin-up + speaking time. */
  ttsDelaySeconds: number;
}

export interface NavTickOptions {
  mode: TravelMode;
  /** Reject fixes worse than this (m) — a sanity gate, not the off-route test. */
  accuracyCapMeters: number;
  /** Fixes worse than this (m) are still used but flag "weak GPS". */
  weakGpsMeters: number;
  /** Ground speed (m/s) above which the traveller counts as moving. */
  minMovingSpeedMps: number;
  reroute: RerouteOpts;
  voice: VoiceScheduleConfig;
  /** Scales every voice trigger earlier (>1) or later (<1) per user preference. */
  announceMultiplier: number;
  arrivalThresholdMeters: number;
  /** Minimum lane-guidance distance (m), used at/below the mode's reference speed. */
  laneGuidanceMeters: number;
  /** Step-advance gate: come within this distance (m) of a step's end (entry). */
  stepGateEntryMeters: number;
  /** Step-advance gate: then travel this far (m) past it before advancing (exit). */
  stepGateExitMeters: number;
}

export interface FixInput {
  coords: LngLat;
  accuracy: number;
  heading?: number | null;
  speed?: number | null;
  timestampMs: number;
  /**
   * True for a synthetic fix produced by the coasting driver during a GPS
   * outage. Runs the normal pipeline (progress, voice, arrival) but must not be
   * recorded, and must not reset the last-real-fix clock that decides coasting.
   */
  coasted?: boolean;
}

export interface NavTickState {
  /**
   * Accrued off-route evidence: +2 per off-route fix while moving, +1 while
   * slow/stopped, with an extra bump when heading the wrong way; reset to 0 once
   * back on route. A reroute fires when it reaches `reroute.scoreThreshold`.
   */
  offRouteScore: number;
  lastRerouteAtMs: number | null;
  /** Current reroute debounce (ms); grows on repeat reroutes, resets on route. 0 = use base. */
  rerouteBackoffMs: number;
  spokenCues: string[];
  /** Snapped arc-length of the previous fix, m — for the speed fallback. */
  lastAlongMeters?: number;
  /** Timestamp of the previous fix, ms — for the speed fallback. */
  lastFixMs?: number;
  /** Previous raw fix position — for deriving the motion bearing when GPS heading is absent. */
  lastRaw?: LngLat;
  /** Previous perpendicular deviation (m) — for the stationary-jitter dead-band. */
  lastDeviation?: number;
  /** Timestamp a sustained U-turn started (ms), else null. */
  uTurnSinceMs?: number | null;
  /** Step currently committed by the step-advance gate (monotonic). */
  committedStepIndex?: number;
  /** Whether the committed step's end has been approached (gate entry phase). */
  reachedStepEnd?: boolean;
}

export interface VoiceCue {
  key: string;
  tier: CueTier;
  step: RouteStep;
  stepIndex: number;
  distance: number;
}

export interface NavTickResult {
  /** null when the fix was rejected (e.g. accuracy too poor). */
  progress: NavProgress | null;
  /** True when the fix was discarded because its accuracy exceeded the cap. */
  accuracyRejected: boolean;
  /** True when the fix was accepted but noisy (accuracy worse than weakGpsMeters). */
  weakGps: boolean;
  offRoute: boolean;
  needsReroute: boolean;
  arrived: boolean;
  voiceCue: VoiceCue | null;
  nextState: NavTickState;
}
