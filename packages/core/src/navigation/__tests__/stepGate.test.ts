import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";
import { advanceStepGate, type StepGateState } from "../stepGate";

// Three 100 m steps; cumulative ends at 100, 200, 300.
const route = {
  distance: 300,
  duration: 60,
  geometry: [],
  legs: [],
  mode: "driving",
  steps: [
    { instruction: "a", distance: 100, duration: 20, coordinates: [] },
    { instruction: "b", distance: 100, duration: 20, coordinates: [] },
    { instruction: "c", distance: 100, duration: 20, coordinates: [] },
  ],
} as unknown as Route;

const ENTRY = 20;
const EXIT = 5;
const fresh: StepGateState = { committedStepIndex: 0, reachedStepEnd: false };

const gate = (along: number, prev: StepGateState) =>
  advanceStepGate(route, along, prev, ENTRY, EXIT);

describe("advanceStepGate", () => {
  it("does not advance before the step's end is approached", () => {
    expect(gate(50, fresh)).toEqual({ committedStepIndex: 0, reachedStepEnd: false });
  });

  it("marks entry within entryMeters of the step end, but holds the step", () => {
    // 85 is within 20 m of the 100 m end → entered, but not yet 5 m past.
    expect(gate(85, fresh)).toEqual({ committedStepIndex: 0, reachedStepEnd: true });
  });

  it("does not advance for a small forward jump just past the maneuver", () => {
    // 101 is past the maneuver but < end+exit (105): the banner must not flip.
    expect(gate(101, fresh)).toEqual({ committedStepIndex: 0, reachedStepEnd: true });
  });

  it("advances once the user travels exitMeters past the maneuver", () => {
    expect(gate(106, { committedStepIndex: 0, reachedStepEnd: true })).toEqual({
      committedStepIndex: 1,
      reachedStepEnd: false,
    });
  });

  it("catches up across multiple steps on a large genuine jump", () => {
    // 250 is past both step 0 and step 1 (ends 100/200, +5 exit) → commit step 2.
    expect(gate(250, fresh).committedStepIndex).toBe(2);
  });

  it("never moves the committed step backward", () => {
    // Already on step 2; a fix that snaps back to 50 m must not retreat.
    expect(gate(50, { committedStepIndex: 2, reachedStepEnd: false }).committedStepIndex).toBe(2);
  });

  it("never advances past the final step", () => {
    expect(gate(999, { committedStepIndex: 2, reachedStepEnd: false }).committedStepIndex).toBe(2);
  });
});
