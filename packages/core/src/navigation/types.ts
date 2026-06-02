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
  offRoute: boolean;
  needsReroute: boolean;
  arrived: boolean;
  voiceCue: VoiceCue | null;
  nextState: NavTickState;
}
