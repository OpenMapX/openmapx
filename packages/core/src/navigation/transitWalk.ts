import type { TransitStep } from "@openmapx/mobility-core/transit";
import { navOptionsForMode } from "./options";
import { nextVoiceCue } from "./voiceCue";

/**
 * Walking-leg guidance, shared by the browser engine and the headless mobile
 * coordinator.
 *
 * Moved out of `apps/web` because the background task needs it and must not
 * import the web app. The maneuver type below is deliberately structural rather
 * than the web's icon type: the web's `maneuverIconFor` accepts it as-is, so no
 * MUI or icon module is dragged into a headless bundle.
 */
export interface TransitWalkManeuver {
  type: "depart" | "continue" | "turn" | "roundabout" | "stairs" | "elevator";
  modifier?:
    | "straight"
    | "left"
    | "right"
    | "slight left"
    | "slight right"
    | "sharp left"
    | "sharp right"
    | "uturn";
}

/**
 * Maps a MOTIS walking `relativeDirection` code to the shared maneuver shape
 * plus a short i18n sub-key for the instruction verb. Stairs and elevator are
 * carried as flags the banner renders with dedicated icons.
 */
const DIRECTION: Record<string, { maneuver: TransitWalkManeuver; key: string }> = {
  DEPART: { maneuver: { type: "depart", modifier: "straight" }, key: "depart" },
  CONTINUE: { maneuver: { type: "continue", modifier: "straight" }, key: "continue" },
  LEFT: { maneuver: { type: "turn", modifier: "left" }, key: "left" },
  RIGHT: { maneuver: { type: "turn", modifier: "right" }, key: "right" },
  SLIGHTLY_LEFT: { maneuver: { type: "turn", modifier: "slight left" }, key: "slightLeft" },
  SLIGHTLY_RIGHT: { maneuver: { type: "turn", modifier: "slight right" }, key: "slightRight" },
  HARD_LEFT: { maneuver: { type: "turn", modifier: "sharp left" }, key: "sharpLeft" },
  HARD_RIGHT: { maneuver: { type: "turn", modifier: "sharp right" }, key: "sharpRight" },
  UTURN_LEFT: { maneuver: { type: "turn", modifier: "uturn" }, key: "uturn" },
  UTURN_RIGHT: { maneuver: { type: "turn", modifier: "uturn" }, key: "uturn" },
  CIRCLE_CLOCKWISE: { maneuver: { type: "roundabout", modifier: "right" }, key: "continue" },
  CIRCLE_COUNTERCLOCKWISE: { maneuver: { type: "roundabout", modifier: "left" }, key: "continue" },
  STAIRS: { maneuver: { type: "stairs" }, key: "stairs" },
  ELEVATOR: { maneuver: { type: "elevator" }, key: "elevator" },
};

const FALLBACK = {
  maneuver: { type: "continue", modifier: "straight" },
  key: "continue",
} as const;

export interface WalkStepInfo {
  instructionText?: string;
  maneuver: TransitWalkManeuver;
  /** i18n sub-key under `navigation.walkDir.*` for the instruction verb. */
  key: string;
  stairs: boolean;
  elevator: boolean;
  /** Street/path the step follows, if named. */
  streetName?: string;
  /** OSM level the step ends on (for elevator/stairs "to level N"). */
  toLevel?: number;
}

export function walkStepInfo(step: TransitStep): WalkStepInfo {
  const d = DIRECTION[step.instruction] ?? FALLBACK;
  return {
    maneuver: d.maneuver,
    instructionText: step.instructionText,
    key: d.key,
    stairs: !!step.stairs || step.instruction === "STAIRS",
    elevator: !!step.elevator || step.instruction === "ELEVATOR",
    streetName: step.streetName || undefined,
    toLevel: step.toLevel,
  };
}

/**
 * Composes a human instruction from a walk step's verb plus street or level,
 * keeping word order per-locale — the join words ("onto", "to level") are
 * themselves translated. `t` is the `navigation` namespace translator.
 */
export function composeWalkInstruction(
  info: WalkStepInfo,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (info.instructionText) return info.instructionText;
  const action = t(`walkDir.${info.key}`);
  if ((info.stairs || info.elevator) && info.toLevel != null) {
    return t("walkToLevel", { action, level: info.toLevel });
  }
  if (info.streetName) return t("walkOnStreet", { action, street: info.streetName });
  return action;
}

/**
 * Given a walk leg's ordered steps and how far along the leg the walker is
 * (0..1), returns the step currently being walked and the metres remaining
 * until its end — the countdown to the next maneuver.
 *
 * Distances come from each step's own length rather than the leg polyline, so
 * this stays correct when the leg and step geometries disagree slightly.
 */
export function walkLegStepProgress(
  steps: Pick<TransitStep, "distanceMeters">[],
  fractionAlongLeg: number,
): { currentStepIndex: number; distanceToNextStepMeters: number } {
  if (steps.length === 0) return { currentStepIndex: 0, distanceToNextStepMeters: 0 };
  const total = steps.reduce((s, st) => s + (st.distanceMeters || 0), 0);
  if (total <= 0) return { currentStepIndex: 0, distanceToNextStepMeters: 0 };

  const target = Math.max(0, Math.min(1, fractionAlongLeg)) * total;
  let cum = 0;
  for (let i = 0; i < steps.length; i++) {
    const len = steps[i].distanceMeters || 0;
    if (cum + len > target || i === steps.length - 1) {
      return { currentStepIndex: i, distanceToNextStepMeters: Math.max(0, cum + len - target) };
    }
    cum += len;
  }
  return { currentStepIndex: steps.length - 1, distanceToNextStepMeters: 0 };
}

/**
 * The next walk step worth announcing after `currentStepIndex`, and how far
 * away it is. Planners split a walk into many steps that only say "continue",
 * with no turn, level or new street, or that carry on up the same stairs;
 * showing those leaves the walker reading "Continue, then continue". They are
 * folded into the distance instead, so the countdown runs to the next real turn. `index` is null when no such step
 * remains, meaning the walk ends at its destination `distanceMeters` away.
 */
export function nextWalkManeuver(
  steps: TransitStep[],
  currentStepIndex: number,
  distanceToNextStepMeters: number,
): { index: number | null; distanceMeters: number } {
  let distanceMeters = distanceToNextStepMeters;
  // Each step is weighed against the last one that wasn't folded away, so a
  // flight of stairs split by a bare "continue" still reads as one.
  const current = steps[currentStepIndex];
  const last = current ? walkStepInfo(current) : undefined;
  for (let i = currentStepIndex + 1; i < steps.length; i++) {
    if (!addsNothing(walkStepInfo(steps[i]), last)) return { index: i, distanceMeters };
    distanceMeters += steps[i].distanceMeters || 0;
  }
  return { index: null, distanceMeters };
}

/**
 * A step that only carries on: no turn, no new street, or the same stairs or
 * lift as the step before, to the same level.
 */
function addsNothing(info: WalkStepInfo, previous: WalkStepInfo | undefined): boolean {
  if (info.instructionText) return false;
  if (info.stairs || info.elevator) {
    return (
      !!previous &&
      previous.stairs === info.stairs &&
      previous.elevator === info.elevator &&
      previous.toLevel === info.toLevel
    );
  }
  return (
    info.maneuver.type === "continue" &&
    (!info.streetName || info.streetName === previous?.streetName)
  );
}

export function transitWalkVoiceCue(
  step: TransitStep,
  index: number,
  distance: number,
  speed: number,
  instruction: string,
  spoken: string[],
) {
  return nextVoiceCue(
    {
      instruction,
      distance: step.distanceMeters,
      duration: step.durationSeconds ?? 0,
      coordinates: step.coordinates ?? [],
      maneuver: walkStepInfo(step).maneuver,
    },
    index,
    distance,
    speed,
    navOptionsForMode("walking").voice,
    1,
    spoken,
  );
}
