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
