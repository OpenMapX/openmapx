import type { RouteStep } from "@integrations/routing/types";
import type { CueTier, VoiceCue } from "./types";

const NOW_METERS = 30;

/**
 * Decide the next voice cue to speak for the current step, given how far the
 * maneuver is and which cue keys have already been spoken. Pure: the caller
 * adds the returned `key` to the spoken set and localizes the phrase from
 * `tier` + `step` + `distance`.
 */
export function nextVoiceCue(
  step: RouteStep,
  stepIndex: number,
  distanceToManeuver: number,
  thresholds: { far: number; near: number },
  spoken: string[],
): VoiceCue | null {
  let tier: CueTier | null = null;
  if (distanceToManeuver <= NOW_METERS) tier = "now";
  else if (distanceToManeuver <= thresholds.near) tier = "near";
  else if (distanceToManeuver <= thresholds.far) tier = "far";
  if (tier === null) return null;

  const key = `${stepIndex}:${tier}`;
  if (spoken.includes(key)) return null;

  return { key, tier, step, stepIndex, distance: distanceToManeuver };
}
