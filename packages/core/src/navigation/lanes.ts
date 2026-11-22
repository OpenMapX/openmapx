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

const MERGE_NARROW_M = 200;
const MERGE_NARROW_MOTORWAY_M = 400;

/** "left"/"right" for a turn modifier ("slight left", "sharp_right", …), else null. */
function modifierSide(modifier: string | undefined): "left" | "right" | null {
  const mod = modifier ? norm(modifier) : "";
  if (mod.endsWith("left")) return "left";
  if (mod.endsWith("right")) return "right";
  return null;
}

/**
 * Anticipate a close second maneuver (immersive navigation spec §9.1): when the
 * next maneuver follows within 200 m (400 m on a motorway) and both lane sets
 * are fully known, keep only the current recommended lanes nearest the side the
 * next maneuver's lanes are on as preferred. It narrows within lanes the engine
 * already recommends and never invents or re-validates a lane; demoted lanes
 * stay usable and lose their bright arrow. Anything uncertain changes nothing.
 */
export function narrowForNextManeuver(
  current: ManeuverLane[],
  next: ManeuverLane[],
  gapMeters: number,
  motorway: boolean,
  nextModifier: string | undefined,
): ManeuverLane[] {
  if (current.length === 0 || next.length === 0) return current;
  if (gapMeters > (motorway ? MERGE_NARROW_MOTORWAY_M : MERGE_NARROW_M)) return current;
  const now = resolveLaneGuidance(current);
  const then = resolveLaneGuidance(next);
  if (now.state !== "known" || then.state !== "known") return current;
  const nextRecommended = then.preferredLanes.length > 0 ? then.preferredLanes : then.usableLanes;
  if (nextRecommended.length === 0) return current;
  const middle = (next.length - 1) / 2;
  const lanesSide = nextRecommended.every((i) => i < middle)
    ? "left"
    : nextRecommended.every((i) => i > middle)
      ? "right"
      : null;
  if (!lanesSide || lanesSide !== modifierSide(nextModifier)) return current;
  const recommended = now.preferredLanes.length > 0 ? now.preferredLanes : now.usableLanes;
  const k = Math.min(recommended.length, Math.max(1, nextRecommended.length));
  // Nothing to narrow when every recommended lane stays.
  if (k === 0 || k === recommended.length) return current;
  const ordered = lanesSide === "left" ? recommended : [...recommended].reverse();
  const kept = new Set(ordered.slice(0, k));
  return current.map((lane, i) => {
    if (!recommended.includes(i)) return lane;
    if (kept.has(i)) return { ...lane, preferred: true };
    const { active: _dropped, ...rest } = lane;
    return { ...rest, preferred: false, narrowed: true };
  });
}

/** The minimal step shape `guidanceLanesForStep` reads, shared by the phone and the car. */
export interface LaneStep {
  distance: number;
  maneuver?: { type?: string; modifier?: string };
  motorway?: boolean;
}

/**
 * The lanes to show for the upcoming maneuver: what the caller resolved for it
 * today, narrowed for a close second maneuver. The one entry point the banner
 * and the car card share, so they always show the same set.
 */
export function guidanceLanesForStep(
  steps: readonly LaneStep[],
  upcomingIndex: number,
  lanes: ManeuverLane[] | undefined,
  nextLanes: ManeuverLane[] | undefined,
): ManeuverLane[] | undefined {
  const step = steps[upcomingIndex];
  if (!lanes || !step || !nextLanes) return lanes;
  const motorway =
    steps[upcomingIndex - 1]?.motorway === true || steps[upcomingIndex]?.motorway === true;
  return narrowForNextManeuver(
    lanes,
    nextLanes,
    step.distance,
    motorway,
    steps[upcomingIndex + 1]?.maneuver?.modifier,
  );
}

/** Retained API: unknown or rejected lanes never become guessed recommendations. */
export function resolveRecommendedLanes(
  lanes: ManeuverLane[] | undefined,
  _maneuver: LaneManeuver | undefined,
): ManeuverLane[] {
  return resolveLaneGuidance(lanes).lanes;
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
 * the branches apart. Arrow direction alone never identifies a routed branch.
 */
export function resolveGuidanceLanes(
  lanes: ManeuverLane[] | undefined,
  maneuver: LaneManeuver | undefined,
  evidence: LaneGuidanceEvidence = {},
): ManeuverLane[] {
  if (!lanes || lanes.length === 0) return lanes ?? [];
  if (lanes.some((l) => l.valid !== undefined)) return lanes;

  const side = sideOf(maneuver);
  const signed = lanesTowardSign(lanes, side, evidence);
  if (signed) return signed;

  return lanes;
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
    if (!hits[i]) return { ...lane, valid: false, preferred: false };
    const toward = side ? lane.indications.find((ind) => norm(ind).includes(side)) : undefined;
    return { ...lane, valid: true, preferred: true, ...(toward ? { active: toward } : {}) };
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

function norm(value: string): string {
  return value.toLowerCase().replace(/[-\s]/g, "_");
}
