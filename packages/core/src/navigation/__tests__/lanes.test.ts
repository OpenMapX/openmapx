import { describe, expect, it } from "vitest";
import type { ManeuverLane } from "../../types/routing";
import { laneGuidanceTriggerMeters, resolveRecommendedLanes } from "../lanes";

const lane = (indications: string[], valid = false): ManeuverLane => ({ indications, valid });

describe("resolveRecommendedLanes", () => {
  it("trusts the engine when a lane is already valid", () => {
    const lanes = [lane(["left"], true), lane(["through"])];
    expect(resolveRecommendedLanes(lanes, { type: "turn", modifier: "right" })).toBe(lanes);
  });

  it("recommends an exact-match lane when the engine didn't decide", () => {
    const lanes = [lane(["left"]), lane(["through"]), lane(["right"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([true, false, false]);
    expect(out[0].active).toBe("left");
  });

  it("falls back to the same side when there's no exact match", () => {
    const lanes = [lane(["slight left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out[0].valid).toBe(true); // slight left serves a left turn
  });

  it("marks through/straight lanes for a straight maneuver", () => {
    const lanes = [lane(["left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "straight" });
    expect(out.map((l) => l.valid)).toEqual([false, true]);
  });

  it("returns [] for no lanes", () => {
    expect(resolveRecommendedLanes(undefined, { type: "turn", modifier: "left" })).toEqual([]);
  });

  it("highlights through lanes for keep-left when a right exit peels away", () => {
    const lanes = [lane(["through"]), lane(["through"]), lane(["slight_right"])];
    const out = resolveRecommendedLanes(lanes, { type: "keep", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([true, true, false]);
  });
});

describe("laneGuidanceTriggerMeters", () => {
  it("keeps the configured city-driving distance at or below reference speed", () => {
    expect(laneGuidanceTriggerMeters("driving", 0)).toBe(500);
    expect(laneGuidanceTriggerMeters("driving", 14)).toBe(500);
  });

  it("shows guidance earlier at motorway speed without showing it kilometres too early", () => {
    expect(laneGuidanceTriggerMeters("driving", 35)).toBe(1250);
    expect(laneGuidanceTriggerMeters("driving", 100)).toBe(1500);
  });
});
