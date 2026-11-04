import type { ManeuverLane } from "../types/routing";
import { type LaneGuidanceEvidence, type LaneManeuver, resolveGuidanceLanes } from "./lanes";

/**
 * The turn-arrow glyphs guidance draws, named after their Material icons. The web
 * renders them as MUI icon components; the Android Auto car screen draws the same
 * glyph paths natively, so the phone and the car show identical arrows.
 */
export type GuidanceIconName =
  | "Straight"
  | "TurnLeft"
  | "TurnRight"
  | "TurnSlightLeft"
  | "TurnSlightRight"
  | "TurnSharpLeft"
  | "TurnSharpRight"
  | "UTurnLeft"
  | "MergeType"
  | "RoundaboutLeft"
  | "RoundaboutRight"
  | "Flag"
  | "Stairs"
  | "Elevator";

/** Directional arrows keyed by normalized token (see {@link normalizeLaneToken}). */
const ARROW_ICONS: Record<string, GuidanceIconName> = {
  straight: "Straight",
  left: "TurnLeft",
  right: "TurnRight",
  "slight left": "TurnSlightLeft",
  "slight right": "TurnSlightRight",
  "sharp left": "TurnSharpLeft",
  "sharp right": "TurnSharpRight",
  uturn: "UTurnLeft",
};

const DIRECTION_ICONS = new Set<GuidanceIconName>(Object.values(ARROW_ICONS));

/** Normalize a turn/lane token: trim, lowercase, and underscores → spaces. */
export function normalizeLaneToken(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, " ");
}

/**
 * Horizontal center, in the 24-unit Material viewBox, of each arrow glyph's stem —
 * the straight base representing the lane you occupy. Turn arrows draw the stem
 * offset toward the base side (a right turn's stem sits left of center, a left
 * turn's to the right), so overlaying two indications in one lane leaves their
 * stems on separate vertical lines. Values measured from the glyph paths.
 */
const STEM_CENTER_X: Partial<Record<GuidanceIconName, number>> = {
  Straight: 12,
  TurnSlightLeft: 14,
  TurnSlightRight: 10,
  TurnLeft: 16,
  TurnRight: 8,
  TurnSharpLeft: 17,
  TurnSharpRight: 7,
  UTurnLeft: 17,
  MergeType: 12,
};

/**
 * Horizontal shift, as a fraction of the icon size, that moves an arrow glyph's stem
 * onto the icon's centerline. Applied when a lane stacks several indications so the
 * stems share one line and only the tips diverge.
 */
export function laneArrowStemShift(icon: GuidanceIconName): number {
  return (12 - (STEM_CENTER_X[icon] ?? 12)) / 24;
}

/**
 * Fork, ramp and exit maneuvers branch off the through road at a shallow angle;
 * a single diagonal arrow on the modifier side reads correctly and the lane strip
 * shows where the other branches go. A bare `left`/`right` becomes its slight
 * (diagonal) variant since a diverge is gentler than a junction turn.
 */
function rampArrowFor(modifier: string): GuidanceIconName {
  const m = normalizeLaneToken(modifier);
  if (m.includes("sharp left")) return "TurnSharpLeft";
  if (m.includes("sharp right")) return "TurnSharpRight";
  if (m.includes("left")) return "TurnSlightLeft";
  if (m.includes("right")) return "TurnSlightRight";
  return "Straight";
}

/** The maneuver's arrow glyph. Falls back to Straight. */
export function maneuverIconName(maneuver: LaneManeuver | undefined): GuidanceIconName {
  const m = maneuver?.modifier ?? "";
  switch (maneuver?.type) {
    case "arrive":
      return "Flag";
    // Pedestrian / indoor maneuvers (transit walk legs; Valhalla foot routing).
    case "stairs":
      return "Stairs";
    case "elevator":
      return "Elevator";
    // OSRM uses `exit roundabout`/`exit rotary` for the leaving maneuver.
    case "roundabout":
    case "rotary":
    case "exit roundabout":
    case "exit rotary":
      return m.includes("left") ? "RoundaboutLeft" : "RoundaboutRight";
    case "merge":
      return "MergeType";
    // Staying on the current road is not taking a fork: a gentle diagonal arrow for
    // keep-left/right and a straight arrow for keep-straight.
    case "keep":
      if (m.includes("left")) return "TurnSlightLeft";
      if (m.includes("right")) return "TurnSlightRight";
      return "Straight";
    // Forks and ramps both branch off the through road; OSRM emits `on ramp`/
    // `off ramp` (Valhalla ramps/exits are normalized to `fork`).
    case "fork":
    case "on ramp":
    case "off ramp":
      return rampArrowFor(m);
  }
  // `turn`, `end of road`, `continue`, `new name`, `roundabout turn`,
  // `notification`, `use lane`, `depart` → a directional arrow from the modifier.
  return ARROW_ICONS[normalizeLaneToken(m)] ?? "Straight";
}

/**
 * The arrow for a lane without painted markings (`none`) that the routing engine
 * says serves the maneuver: the maneuver's own direction. `null` when the maneuver
 * has no plain direction to draw in a lane (arrival, roundabout, merge, stairs).
 */
export function unmarkedLaneIconName(maneuver: LaneManeuver | undefined): GuidanceIconName | null {
  if (!maneuver) return null;
  const icon = maneuverIconName(maneuver);
  return DIRECTION_ICONS.has(icon) ? icon : null;
}

/**
 * A lane *indication* token's glyph, covering the OSRM and Valhalla vocabularies
 * (space- or underscore-separated; `through` ≈ straight, `reverse` ≈ uturn). `null`
 * for an empty `none` lane. Unknown tokens fall back to a straight arrow.
 */
export function laneIndicationIconName(indication: string): GuidanceIconName | null {
  const token = normalizeLaneToken(indication);
  if (token === "" || token === "none") return null;
  if (token === "merge to left" || token === "merge to right") return "MergeType";
  if (token === "through") return "Straight";
  if (token === "reverse") return "UTurnLeft";
  return ARROW_ICONS[token] ?? "Straight";
}

export interface GuidanceLaneArrow {
  indication: string;
  icon: GuidanceIconName;
  /** The recommended arrow of a lane you may take, drawn brightest. */
  active: boolean;
  /** Fraction of the icon size to shift so stacked arrows share one stem. */
  stemShift: number;
}

export interface GuidanceLaneCell {
  /** A lane you may take for this maneuver. */
  valid: boolean;
  /** The arrow was inferred from the maneuver because the lane is unmarked. */
  inferred: boolean;
  /** Empty for an unmarked lane: a blank cell. */
  arrows: GuidanceLaneArrow[];
}

/**
 * Turn-lane guidance as drawn: one cell per lane, each with its arrows and which
 * of them is recommended. Lanes come from {@link resolveGuidanceLanes}; an unmarked
 * lane the engine chose carries the maneuver's own arrow. Shared by the phone's
 * banner and the car's routing card so both show the same lanes and arrows.
 */
export function presentGuidanceLanes(
  lanes: ManeuverLane[] | undefined,
  maneuver: LaneManeuver | undefined,
  evidence: LaneGuidanceEvidence = {},
): GuidanceLaneCell[] {
  const resolved = resolveGuidanceLanes(lanes, maneuver, evidence);
  // Only the engine knows an unmarked lane leads into the maneuver; lanes we
  // recommended ourselves stay blank rather than gain a guessed arrow.
  const engineChose = lanes?.some((l) => l.valid) ?? false;
  const unmarkedIcon = engineChose ? unmarkedLaneIconName(maneuver) : null;
  return resolved.map((lane) => {
    const marked = lane.indications.flatMap((indication) => {
      const icon = laneIndicationIconName(indication);
      return icon ? [{ indication, icon }] : [];
    });
    const fallback = marked.length === 0 && lane.valid ? unmarkedIcon : null;
    const inferred = fallback !== null;
    const arrows = fallback ? [{ indication: "none", icon: fallback }] : marked;
    const activeNorm = lane.active && !inferred ? normalizeLaneToken(lane.active) : null;
    return {
      valid: lane.valid,
      inferred,
      arrows: arrows.map(({ indication, icon }) => ({
        indication,
        icon,
        active:
          lane.valid &&
          (activeNorm ? normalizeLaneToken(indication) === activeNorm : arrows.length === 1),
        stemShift: arrows.length > 1 ? laneArrowStemShift(icon) : 0,
      })),
    };
  });
}
