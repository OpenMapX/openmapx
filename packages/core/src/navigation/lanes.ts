import type { LaneDestinations } from "../types/junction";
import type { ManeuverLane, ManeuverSign, TravelMode } from "../types/routing";
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

/** What else is known about where the lanes lead, beyond the engine's arrows. */
export interface LaneGuidanceEvidence {
  /** The maneuver's signage: the branch refs and places the route heads for. */
  sign?: ManeuverSign;
  /** OSM destinations per lane on the approach, left to right. */
  laneDestinations?: LaneDestinations[];
}

/**
 * The lanes to highlight in turn-lane guidance. The engine's own choice wins.
 * Without it, lanes whose OSM destinations name the maneuver's sign come next:
 * at a split tagged `through` on every lane, they are the only thing telling
 * the branches apart. Then `resolveRecommendedLanes`, except where it lights
 * every lane for a maneuver to one side through arrows that do not point that
 * way: all four `through` lanes before a split say nothing about which two
 * keep left, so none is highlighted rather than all. Pure.
 */
export function resolveGuidanceLanes(
  lanes: ManeuverLane[] | undefined,
  maneuver: LaneManeuver | undefined,
  evidence: LaneGuidanceEvidence = {},
): ManeuverLane[] {
  if (!lanes || lanes.length === 0) return lanes ?? [];
  if (lanes.some((l) => l.valid)) return lanes;

  const side = sideOf(maneuver);
  const signed = lanesTowardSign(lanes, side, evidence);
  if (signed) return signed;

  const resolved = resolveRecommendedLanes(lanes, maneuver);
  const uninformative =
    side !== null &&
    resolved.every((l) => l.valid) &&
    !resolved.some((l) => l.active !== undefined && norm(l.active).includes(side));
  return uninformative ? lanes : resolved;
}

function sideOf(maneuver: LaneManeuver | undefined): "left" | "right" | null {
  const mod = maneuver?.modifier ? norm(maneuver.modifier) : "";
  return mod.includes("left") ? "left" : mod.includes("right") ? "right" : null;
}

/**
 * Mark the lanes whose OSM destinations name the sign's places, else those
 * whose refs name its branches. `null` when the evidence does not fit the
 * lanes or does not tell them apart: no lane matches, or every lane does.
 */
function lanesTowardSign(
  lanes: ManeuverLane[],
  side: "left" | "right" | null,
  { sign, laneDestinations }: LaneGuidanceEvidence,
): ManeuverLane[] | null {
  if (!sign || !laneDestinations || laneDestinations.length !== lanes.length) return null;
  // Places first: a split's lanes often share the road ref ("A 44" on every
  // lane) and differ only in the towns they serve.
  const places = new Set((sign.exitToward ?? []).map(placeKey));
  const refs = new Set((sign.exitBranches ?? []).map(refKey));
  const hits =
    distinguishing(
      laneDestinations.map((l) => l.destinations.some((p) => places.has(placeKey(p)))),
    ) ?? distinguishing(laneDestinations.map((l) => l.refs.some((r) => refs.has(refKey(r)))));
  if (!hits) return null;
  return lanes.map((lane, i) => {
    if (!hits[i]) return { ...lane, valid: false };
    const toward = side ? lane.indications.find((ind) => norm(ind).includes(side)) : undefined;
    return { ...lane, valid: true, ...(toward ? { active: toward } : {}) };
  });
}

/** The per-lane matches, unless they match no lane or every lane. */
function distinguishing(hits: boolean[]): boolean[] | null {
  const count = hits.filter(Boolean).length;
  return count === 0 || count === hits.length ? null : hits;
}

function placeKey(place: string): string {
  return place.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** "A44" and "A 44" name the same road. */
function refKey(ref: string): string {
  return ref.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}
