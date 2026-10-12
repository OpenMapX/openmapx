import type { ManeuverLane, TravelMode } from "../types/routing";
import { navOptionsForMode } from "./options";

export interface LaneManeuver {
  type: string;
  modifier?: string;
}

/**
 * Distance-to-maneuver at which "detailed guidance" (lane guidance and the
 * next-step preview) becomes relevant. Modelled as a lead TIME before the
 * maneuver, converted to distance at the current speed, so it self-adapts: a
 * short window in the city and a long one on the motorway (up to
 * `maxLeadSeconds`), where you need more warning to change lanes for an exit.
 * The lead grows from `leadSeconds` at the reference speed to `maxLeadSeconds`
 * at `highSpeedMps`, floored at `minMeters` so a near-stop still shows in time.
 */
export function guidanceApproachMeters(mode: TravelMode, currentSpeedMps: number): number {
  const { guidance: g, voice } = navOptionsForMode(mode);
  const low = voice.refSpeedMps;
  const span = Math.max(g.highSpeedMps - low, 1e-6);
  const t = Math.min(Math.max((currentSpeedMps - low) / span, 0), 1);
  const leadSeconds = g.leadSeconds + t * (g.maxLeadSeconds - g.leadSeconds);
  return Math.max(g.minMeters, Math.max(currentSpeedMps, 0) * leadSeconds);
}

/** Lead time for the junction photo, seconds, and the floor it never drops below. */
const PHOTO_LEAD_SECONDS = 30;
const PHOTO_MIN_METERS = 300;

/**
 * Distance at which the junction photo is worth showing. The gantry goes up
 * with the rest of the guidance, minutes ahead on the motorway, but a picture
 * of a junction that far off shows a road you cannot place yet — and it holds
 * a large part of the screen. Half a minute of travel puts it up when what it
 * shows is about to appear through the windscreen, never beyond the guidance
 * window that carries it.
 */
export function junctionPhotoApproachMeters(mode: TravelMode, currentSpeedMps: number): number {
  const lead = Math.max(Math.max(currentSpeedMps, 0) * PHOTO_LEAD_SECONDS, PHOTO_MIN_METERS);
  return Math.min(lead, guidanceApproachMeters(mode, currentSpeedMps));
}

/**
 * Whether to preview the maneuver *after* the upcoming one ("Then …"). Two
 * conditions: we're inside the approach window for the current maneuver (so it's
 * relevant at all — not shown with many km still to go), AND the following
 * maneuver comes soon after it (`nextStep.duration ≤ chainSeconds`), so the
 * chain is worth previewing rather than two far-apart turns. Falls back to a
 * distance gap when the engine omits the next step's duration.
 */
export function shouldPreviewNextStep(
  mode: TravelMode,
  currentSpeedMps: number,
  distanceToManeuver: number,
  nextStepDurationSec: number,
  nextStepDistanceMeters?: number,
): boolean {
  if (distanceToManeuver > guidanceApproachMeters(mode, currentSpeedMps)) return false;
  const { guidance: g, voice } = navOptionsForMode(mode);
  if (Number.isFinite(nextStepDurationSec) && nextStepDurationSec > 0) {
    return nextStepDurationSec <= g.chainSeconds;
  }
  return (nextStepDistanceMeters ?? Number.POSITIVE_INFINITY) <= g.chainSeconds * voice.refSpeedMps;
}

export interface ResolvedLaneGuidance {
  lanes: ManeuverLane[];
  usableLanes: number[];
  preferredLanes: number[];
  state: "known" | "partial" | "unknown" | "conflict";
}

/** Preserve reported meaning; a turn arrow alone does not identify a routed branch. */
export function resolveLaneGuidance(lanes: ManeuverLane[] | undefined): ResolvedLaneGuidance {
  const values = lanes ?? [];
  const conflict = values.some((lane) => lane.preferred === true && lane.valid === false);
  const reported = values.filter((lane) => lane.valid !== undefined).length;
  return {
    lanes: values,
    usableLanes: values.flatMap((lane, i) => (lane.valid === true ? [i] : [])),
    preferredLanes: values.flatMap((lane, i) =>
      lane.valid === true && lane.preferred === true ? [i] : [],
    ),
    state: conflict
      ? "conflict"
      : reported === 0
        ? "unknown"
        : reported === values.length
          ? "known"
          : "partial",
  };
}

/** Retained API: unknown or rejected lanes never become guessed recommendations. */
export function resolveRecommendedLanes(
  lanes: ManeuverLane[] | undefined,
  _maneuver: LaneManeuver | undefined,
): ManeuverLane[] {
  return resolveLaneGuidance(lanes).lanes;
}
