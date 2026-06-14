import type { RouteStep } from "@integrations/routing/types";
import type { CueTier, VoiceCue, VoiceScheduleConfig } from "./types";

/**
 * Decide the next voice cue for the current step using speed-adaptive trigger
 * distances. Each stage fires a fixed time ahead of the maneuver: the far/near
 * distances scale UP (never down) with the current speed and are padded by a
 * TTS-latency term, so a prompt that lands ~400 m before a turn at city speed
 * lands ~1 km before it on a motorway and finishes before you arrive.
 * `multiplier` shifts every trigger earlier (>1) or later (<1) per the user's
 * announcement-time preference.
 *
 * Pure: the caller adds the returned `key` to the spoken set and localizes the
 * phrase from `tier` + `step` + `distance`.
 */
export function nextVoiceCue(
  step: RouteStep,
  stepIndex: number,
  distanceToManeuver: number,
  currentSpeedMps: number,
  config: VoiceScheduleConfig,
  multiplier: number,
  spoken: string[],
): VoiceCue | null {
  const speed = Math.max(currentSpeedMps, 0);
  const m = multiplier > 0 ? multiplier : 1;
  // The effective speed never drops below the reference, so a stopped or slow
  // traveller still gets a sane minimum lead distance rather than a near-zero
  // one. Above the reference, distances grow linearly with speed.
  const speedRatio = Math.max(speed, config.refSpeedMps) / config.refSpeedMps;
  const latency = speed * config.ttsDelaySeconds;

  const farTrigger = config.farMeters * speedRatio * m + latency;
  const nearTrigger = config.nearMeters * speedRatio * m + latency;
  const nowTrigger = Math.max(config.nowFloorMeters, config.nowSeconds * speed) * m + latency;

  let tier: CueTier | null = null;
  if (distanceToManeuver <= nowTrigger) tier = "now";
  else if (distanceToManeuver <= nearTrigger) tier = "near";
  else if (distanceToManeuver <= farTrigger) tier = "far";
  if (tier === null) return null;

  const key = `${stepIndex}:${tier}`;
  if (spoken.includes(key)) return null;

  return { key, tier, step, stepIndex, distance: distanceToManeuver };
}
