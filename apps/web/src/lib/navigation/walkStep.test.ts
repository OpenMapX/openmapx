import type { TransitStep } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { composeWalkInstruction, walkLegStepProgress, walkStepInfo } from "./walkStep";

// Minimal fake translator mirroring the ICU templates used in the catalog.
const fakeT = (key: string, values?: Record<string, string | number>): string => {
  const dict: Record<string, string> = {
    "walkDir.left": "Turn left",
    "walkDir.continue": "Continue",
    "walkDir.stairs": "Take the stairs",
    walkOnStreet: `${values?.action} onto ${values?.street}`,
    walkToLevel: `${values?.action} to level ${values?.level}`,
  };
  return dict[key] ?? key;
};

function step(partial: Partial<TransitStep>): TransitStep {
  return { instruction: "CONTINUE", distanceMeters: 0, ...partial };
}

describe("walkStepInfo", () => {
  it("maps MOTIS directions to the shared maneuver vocabulary + verb key", () => {
    expect(walkStepInfo(step({ instruction: "LEFT", streetName: "Main St" }))).toMatchObject({
      maneuver: { type: "turn", modifier: "left" },
      key: "left",
      streetName: "Main St",
    });
    expect(walkStepInfo(step({ instruction: "SLIGHTLY_RIGHT" })).maneuver.modifier).toBe(
      "slight right",
    );
    expect(walkStepInfo(step({ instruction: "HARD_LEFT" })).maneuver.modifier).toBe("sharp left");
  });

  it("flags stairs and elevator steps with their level", () => {
    expect(walkStepInfo(step({ instruction: "STAIRS", toLevel: 1 }))).toMatchObject({
      stairs: true,
      key: "stairs",
      toLevel: 1,
    });
    expect(
      walkStepInfo(step({ instruction: "ELEVATOR", toLevel: 2, elevator: true })),
    ).toMatchObject({ elevator: true, key: "elevator", toLevel: 2 });
  });

  it("falls back to continue for unknown directions", () => {
    expect(walkStepInfo(step({ instruction: "WHAT" })).key).toBe("continue");
  });
});

describe("composeWalkInstruction", () => {
  it("appends the street when the step follows a named path", () => {
    expect(
      composeWalkInstruction(
        walkStepInfo(step({ instruction: "LEFT", streetName: "Main St" })),
        fakeT,
      ),
    ).toBe("Turn left onto Main St");
  });

  it("appends the level for stairs/elevator with a level change", () => {
    expect(
      composeWalkInstruction(walkStepInfo(step({ instruction: "STAIRS", toLevel: 1 })), fakeT),
    ).toBe("Take the stairs to level 1");
  });

  it("uses the bare verb when there is no street or level", () => {
    expect(composeWalkInstruction(walkStepInfo(step({ instruction: "CONTINUE" })), fakeT)).toBe(
      "Continue",
    );
  });
});

describe("walkLegStepProgress", () => {
  const steps = [
    step({ distanceMeters: 100 }),
    step({ distanceMeters: 50 }),
    step({ distanceMeters: 150 }),
  ];

  it("reports the first step and its full length at the start", () => {
    expect(walkLegStepProgress(steps, 0)).toEqual({
      currentStepIndex: 0,
      distanceToNextStepMeters: 100,
    });
  });

  it("counts down within the current step", () => {
    // fraction 0.4 of 300m = 120m → into step 1 (100..150), 30m remaining.
    expect(walkLegStepProgress(steps, 0.4)).toEqual({
      currentStepIndex: 1,
      distanceToNextStepMeters: 30,
    });
  });

  it("advances to the last step near the end", () => {
    // fraction 0.5 = 150m = start of step 2 (last), its full 150m remaining.
    expect(walkLegStepProgress(steps, 0.5)).toEqual({
      currentStepIndex: 2,
      distanceToNextStepMeters: 150,
    });
  });

  it("handles empty or zero-length steps", () => {
    expect(walkLegStepProgress([], 0.5)).toEqual({
      currentStepIndex: 0,
      distanceToNextStepMeters: 0,
    });
  });
});
