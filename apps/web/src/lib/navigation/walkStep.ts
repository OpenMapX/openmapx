import type { TransitStep } from "@openmapx/mobility-core/transit";
import type { Maneuver } from "./maneuverIcon";

/**
 * Map a MOTIS walking `relativeDirection` code to the shared maneuver shape (so
 * the driving/walking {@link maneuverIconFor} icon vocabulary is reused) plus a
 * short i18n sub-key for the instruction verb. Stairs/elevator are carried as
 * flags the banner renders with dedicated icons.
 */
const DIRECTION: Record<string, { maneuver: Maneuver; key: string }> = {
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

const FALLBACK = { maneuver: { type: "continue", modifier: "straight" }, key: "continue" } as const;

export interface WalkStepInfo {
  maneuver: Maneuver;
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
    key: d.key,
    stairs: !!step.stairs || step.instruction === "STAIRS",
    elevator: !!step.elevator || step.instruction === "ELEVATOR",
    streetName: step.streetName || undefined,
    toLevel: step.toLevel,
  };
}

/**
 * Compose a human instruction from a walk step's verb + street/level, keeping
 * word order per-locale (the join words "onto"/"to level" are themselves
 * translated). `t` is the `navigation` namespace translator.
 */
export function composeWalkInstruction(
  info: WalkStepInfo,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const action = t(`walkDir.${info.key}`);
  if ((info.stairs || info.elevator) && info.toLevel != null) {
    return t("walkToLevel", { action, level: info.toLevel });
  }
  if (info.streetName) return t("walkOnStreet", { action, street: info.streetName });
  return action;
}

/**
 * Given a walk leg's ordered steps and how far along the leg the walker is
 * (0..1), return the step currently being walked and the metres remaining until
 * its end — i.e. the countdown to the next maneuver. Distances come from each
 * step's own length (summed), so this is robust to the leg polyline and step
 * polylines disagreeing slightly. Pure and unit-tested.
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
