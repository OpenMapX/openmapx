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

/** Normalize a lane/turn token: trim, lowercase, underscores → spaces. */
function norm(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, " ");
}

/** Mark a lane valid (and set its active indication) when one of its indications matches. */
function markIfMatch(lane: ManeuverLane, matches: (indication: string) => boolean): ManeuverLane {
  const hit = lane.indications.find((i) => matches(norm(i)));
  if (!hit) return { ...lane, valid: false };
  return { ...lane, valid: true, active: hit };
}

/**
 * Decide which lanes to highlight for an upcoming maneuver. When the routing
 * engine already marked a lane valid we trust it; otherwise we recommend lanes
 * ourselves from the maneuver. A `keep` instruction first prefers through
 * lanes because the named side describes the branch to stay on, not a turn to
 * make. Other maneuvers use exact direction → same side → unrestricted. Pure.
 */
export function resolveRecommendedLanes(
  lanes: ManeuverLane[] | undefined,
  maneuver: LaneManeuver | undefined,
): ManeuverLane[] {
  if (!lanes || lanes.length === 0) return lanes ?? [];
  if (lanes.some((l) => l.valid)) return lanes; // engine already decided

  const mod = maneuver?.modifier ? norm(maneuver.modifier) : "";

  // "Keep left/right to stay on …" commonly means remaining in the through
  // carriageway while an exit peels away on the other side. Highlight the
  // through lanes instead of looking for a literal left/right turn arrow.
  if (maneuver?.type === "keep") {
    const through = lanes.map((l) =>
      markIfMatch(l, (i) => i === "through" || i === "straight" || i === "none" || i === ""),
    );
    if (through.some((l) => l.valid)) return through;
  }

  // Going straight (or no modifier): a through/straight/unmarked lane keeps you on-route.
  if (mod === "" || mod === "straight") {
    return lanes.map((l) =>
      markIfMatch(l, (i) => i === "through" || i === "straight" || i === "none" || i === ""),
    );
  }

  const exact = lanes.map((l) => markIfMatch(l, (i) => i === mod));
  if (exact.some((l) => l.valid)) return exact;

  const side = mod.includes("left") ? "left" : mod.includes("right") ? "right" : null;
  if (side) {
    const approx = lanes.map((l) => markIfMatch(l, (i) => i.includes(side)));
    if (approx.some((l) => l.valid)) return approx;
  }

  // Last resort: an unrestricted lane is usable for any maneuver.
  return lanes.map((l) => markIfMatch(l, (i) => i === "none" || i === ""));
}
