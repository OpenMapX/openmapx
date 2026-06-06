import type { RouteStep, TravelMode } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";

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
  thresholdMeters: number;
  consecutiveFixes: number;
  debounceMs: number;
}

export interface NavTickOptions {
  mode: TravelMode;
  accuracyCapMeters: number;
  reroute: RerouteOpts;
  voiceThresholds: { far: number; near: number };
  arrivalThresholdMeters: number;
  /** Show lane guidance only within this distance (m) of the next maneuver. */
  laneGuidanceMeters: number;
}

export interface FixInput {
  coords: LngLat;
  accuracy: number;
  heading?: number | null;
  speed?: number | null;
  timestampMs: number;
}

export interface NavTickState {
  deviationHistory: number[];
  lastRerouteAtMs: number | null;
  spokenCues: string[];
  /** Snapped arc-length of the previous fix, m — for the speed fallback. */
  lastAlongMeters?: number;
  /** Timestamp of the previous fix, ms — for the speed fallback. */
  lastFixMs?: number;
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
  offRoute: boolean;
  needsReroute: boolean;
  arrived: boolean;
  voiceCue: VoiceCue | null;
  nextState: NavTickState;
}
