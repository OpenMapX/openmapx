import type { RouteStep } from "../types/routing";

/**
 * Something visible a near voice prompt can name instead of a distance ("At
 * the second traffic light, turn right"). Shared by the browser voice and the
 * native ground cues.
 *
 * These types mirror `NavigationLandmarkCategory` and `NavigationCueReference`
 * in `@openmapx/i18n`, which core does not depend on. The call sites import
 * both, so a drift fails to compile there.
 */
export type SpokenLandmarkCategory =
  | "fuel"
  | "church"
  | "mosque"
  | "synagogue"
  | "pharmacy"
  | "supermarket"
  | "fast_food";

export type CueReference =
  | { kind: "traffic-light"; ordinal: 1 | 2 | 3 }
  | { kind: "landmark"; category: SpokenLandmarkCategory; brand?: string };

/** The landmark chosen for one manoeuvre. */
export interface LandmarkReference {
  stepIndex: number;
  category: SpokenLandmarkCategory;
  brand?: string;
}

/** Signals this close along the route belong to one junction. */
const CLUSTER_GAP_M = 50;
/** The turn's own junction ends at most this far before the manoeuvre point. */
const AT_MANEUVER_M = 20;
/** A junction closer than this to the puck is being passed, not ahead. */
const PUCK_MARGIN_M = 15;
const MAX_ORDINAL = 3;

/**
 * Which traffic light, counted from the puck, the manoeuvre is at, or null.
 *
 * Signals past the manoeuvre are dropped first, so the far stop line of the
 * turn's own junction (often a few metres beyond the turn on the outgoing
 * road) cannot push the junction past the 20 m rule. A junction counts only
 * when its first signal lies at least 15 m ahead of the puck: one the driver
 * is standing in is not "the first traffic light".
 */
export function trafficLightReference(
  signalsAlong: number[],
  puckAlong: number,
  maneuverAlong: number,
): 1 | 2 | 3 | null {
  const sorted = signalsAlong
    .filter((along) => Number.isFinite(along) && along <= maneuverAlong)
    .sort((a, b) => a - b);
  const clusters: { first: number; last: number }[] = [];
  for (const along of sorted) {
    const current = clusters.at(-1);
    if (current && along - current.last <= CLUSTER_GAP_M) current.last = along;
    else clusters.push({ first: along, last: along });
  }
  const target = clusters.at(-1);
  if (!target || target.last < maneuverAlong - AT_MANEUVER_M) return null;
  const ahead = clusters.filter((cluster) => cluster.first >= puckAlong + PUCK_MARGIN_M);
  if (ahead.at(-1) !== target) return null;
  const ordinal = ahead.length;
  return ordinal >= 1 && ordinal <= MAX_ORDINAL ? (ordinal as 1 | 2 | 3) : null;
}

const TURN_MODIFIERS = new Set([
  "left",
  "right",
  "slight left",
  "slight right",
  "sharp left",
  "sharp right",
]);
const NON_TURN_TYPES = new Set(["uturn", "arrive", "depart"]);

/** A real turn at a junction: the manoeuvres a visible reference helps with. */
function isTurnManeuver(step: RouteStep | undefined): boolean {
  const maneuver = step?.maneuver;
  if (!maneuver?.modifier) return false;
  if (NON_TURN_TYPES.has(maneuver.type.toLowerCase())) return false;
  return TURN_MODIFIERS.has(maneuver.modifier.toLowerCase().replace(/[-_]/g, " "));
}

function isMotorwayStep(steps: RouteStep[], index: number): boolean {
  return steps[index - 1]?.motorway === true || steps[index]?.motorway === true;
}

/** Whether the union of `spans` covers `[from, to]` without a gap. */
function covers(spans: { from: number; to: number }[], from: number, to: number): boolean {
  let reached = from;
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    if (span.from > reached) break;
    reached = Math.max(reached, span.to);
    if (reached >= to) return true;
  }
  return reached >= to;
}

export interface ChooseReferenceInput {
  steps: RouteStep[];
  /** Index of the step whose manoeuvre the cue announces. */
  stepIndex: number;
  maneuverAlong: number;
  puckAlong: number;
  /** Route-ordered signal along-distances, or null without a map-matcher. */
  signalsAlong: number[] | null;
  /** Along-distance spans whose match windows were fetched successfully. */
  fetchedSpans: { from: number; to: number }[];
  landmark: LandmarkReference | null;
}

/**
 * The reference to speak for a cue, or null. Turn manoeuvres off the
 * motorway only. A traffic light wins over a landmark, and is used only when
 * every metre between puck and manoeuvre was matched: an unseen signal would
 * make the ordinal wrong.
 */
export function chooseReference(input: ChooseReferenceInput): CueReference | null {
  const { steps, stepIndex } = input;
  if (!isTurnManeuver(steps[stepIndex]) || isMotorwayStep(steps, stepIndex)) return null;
  if (
    input.signalsAlong !== null &&
    covers(input.fetchedSpans, input.puckAlong, input.maneuverAlong)
  ) {
    const ordinal = trafficLightReference(input.signalsAlong, input.puckAlong, input.maneuverAlong);
    if (ordinal !== null) return { kind: "traffic-light", ordinal };
  }
  const landmark = input.landmark;
  if (landmark && landmark.stepIndex === stepIndex) {
    return {
      kind: "landmark",
      category: landmark.category,
      ...(landmark.brand !== undefined && { brand: landmark.brand }),
    };
  }
  return null;
}
