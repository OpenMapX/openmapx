import type { ManeuverLane, TravelMode } from "../types/routing";
import { navOptionsForMode } from "./options";

export interface LaneManeuver {
  type: string;
  modifier?: string;
}

/**
 * Distance at which lane guidance should appear. The configured per-mode value
 * is the city/reference-speed minimum; above that speed it grows linearly, up
 * to 3×, so motorway guidance appears around 1–1.5 km out without lingering
 * for many kilometres.
 */
export function laneGuidanceTriggerMeters(mode: TravelMode, currentSpeedMps: number): number {
  const options = navOptionsForMode(mode);
  const referenceSpeed = options.voice.refSpeedMps;
  const speedRatio = Math.max(currentSpeedMps, referenceSpeed) / referenceSpeed;
  return options.laneGuidanceMeters * Math.min(speedRatio, 3);
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
