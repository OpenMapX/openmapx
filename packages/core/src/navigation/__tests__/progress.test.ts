import type { Route } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
import { computeProgress, upcomingManeuverIndex } from "../progress";

describe("upcomingManeuverIndex", () => {
  it("points at the maneuver at the END of the current step (currentStepIndex + 1)", () => {
    expect(upcomingManeuverIndex(0, 5)).toBe(1);
    expect(upcomingManeuverIndex(3, 5)).toBe(4);
  });

  it("clamps to the final (arrival) step", () => {
    expect(upcomingManeuverIndex(4, 5)).toBe(4);
    expect(upcomingManeuverIndex(0, 1)).toBe(0);
  });

  it("is safe for an empty route", () => {
    expect(upcomingManeuverIndex(0, 0)).toBe(0);
  });
});

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

describe("computeProgress", () => {
  it("locates the current step from along-distance", () => {
    const p = computeProgress(route, 150);
    expect(p.currentStepIndex).toBe(1);
    expect(p.distanceToNextManeuver).toBe(50); // end of step 1 (200) - 150
    expect(p.distanceRemaining).toBe(150);
  });

  it("computes distances for a forced step index (the step-advance gate)", () => {
    // At 150 m the snapped position is in step 1, but the gate may still hold
    // step 0 (maneuver not yet completed): distances are then measured to the
    // end of step 0.
    const p = computeProgress(route, 150, 0);
    expect(p.currentStepIndex).toBe(0);
    expect(p.distanceToNextManeuver).toBe(0); // end of step 0 (100) - 150, clamped
    expect(p.distanceRemaining).toBe(150); // geometric, gate-independent
  });

  it("keeps durationRemaining geometric when the gate forces an earlier step", () => {
    // The gate forcing step 0 at along=150 must not add step 1's full duration
    // on top of the part of step 1 already driven — ETA stays geometric.
    const forced = computeProgress(route, 150, 0);
    const geometric = computeProgress(route, 150);
    expect(forced.durationRemaining).toBe(geometric.durationRemaining);
  });

  it("computes duration remaining as partial current step + later steps", () => {
    const p = computeProgress(route, 150); // half of step 1 left + step 2
    expect(p.durationRemaining).toBeCloseTo(30, 5); // 10 + 20
  });

  it("clamps past the end", () => {
    const p = computeProgress(route, 999);
    expect(p.currentStepIndex).toBe(2);
    expect(p.distanceRemaining).toBe(0);
    expect(p.distanceToNextManeuver).toBe(0);
  });
});
