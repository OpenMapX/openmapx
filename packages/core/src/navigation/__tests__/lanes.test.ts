import { describe, expect, it } from "vitest";
import type { ManeuverLane } from "../../types/routing";
import { guidanceApproachMeters, resolveRecommendedLanes, shouldPreviewNextStep } from "../lanes";

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

describe("guidanceApproachMeters", () => {
  it("floors at the minimum distance when stopped or slow", () => {
    expect(guidanceApproachMeters("driving", 0)).toBe(300);
    expect(guidanceApproachMeters("driving", 5)).toBe(300);
  });

  it("gives roughly the city lead time around reference speed", () => {
    // 35 s lead at ~50 km/h → 14 m/s × 35 s.
    expect(guidanceApproachMeters("driving", 14)).toBe(490);
  });

  it("stretches the lead TIME on the motorway, not just distance", () => {
    // 90 s lead at ~120 km/h → 33 m/s × 90 s.
    expect(guidanceApproachMeters("driving", 33)).toBe(2970);
    // The implied lead time is far larger at motorway speed than in the city.
    const cityLead = guidanceApproachMeters("driving", 14) / 14;
    const autobahnLead = guidanceApproachMeters("driving", 33) / 33;
    expect(autobahnLead).toBeGreaterThan(cityLead * 2);
  });

  it("interpolates the lead between city and motorway speed", () => {
    expect(guidanceApproachMeters("driving", 25)).toBeCloseTo(1671, 0);
  });
});

describe("shouldPreviewNextStep", () => {
  it("hides the preview while the maneuver is still far off", () => {
    // 2000 m out at city speed is well beyond the ~490 m approach window.
    expect(shouldPreviewNextStep("driving", 14, 2000, 10)).toBe(false);
  });

  it("shows the preview when approaching and the next maneuver follows closely", () => {
    expect(shouldPreviewNextStep("driving", 14, 300, 15)).toBe(true);
  });

  it("hides the preview when the next maneuver is far after this one", () => {
    // Approaching, but the gap to the following maneuver is 90 s — not a chain.
    expect(shouldPreviewNextStep("driving", 14, 300, 90)).toBe(false);
  });

  it("falls back to a distance gap when the engine omits the next-step duration", () => {
    // 350 m = 25 s × 14 m/s reference.
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 200)).toBe(true);
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 800)).toBe(false);
  });
});
