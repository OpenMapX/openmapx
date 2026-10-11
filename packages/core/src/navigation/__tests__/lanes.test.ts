import { describe, expect, it } from "vitest";
import type { ManeuverLane } from "../../types/routing";
import {
  guidanceApproachMeters,
  junctionPhotoApproachMeters,
  resolveLaneGuidance,
  resolveRecommendedLanes,
  shouldPreviewNextStep,
} from "../lanes";

const lane = (indications: string[], valid = false): ManeuverLane => ({ indications, valid });

describe("resolveRecommendedLanes", () => {
  it("does not turn unknown arrows into an invented recommendation", () => {
    const result = resolveLaneGuidance([{ indications: ["left"] }, { indications: ["through"] }]);
    expect(result.state).toBe("unknown");
    expect(result.usableLanes).toEqual([]);
    expect(result.preferredLanes).toEqual([]);
  });
  it("keeps initially usable and preferred sets distinct", () => {
    const result = resolveLaneGuidance([
      { indications: ["left"], valid: true, preferred: false },
      { indications: ["left"], valid: true, preferred: true },
      { indications: ["right"], valid: false, preferred: false },
    ]);
    expect(result.usableLanes).toEqual([0, 1]);
    expect(result.preferredLanes).toEqual([1]);
    expect(result.state).toBe("known");
  });
  it("preserves explicit engine rejection instead of guessing from turn arrows", () => {
    const lanes = [lane(["left"], false), lane(["through"], false), lane(["right"], false)];
    expect(
      resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" }).map((l) => l.valid),
    ).toEqual([false, false, false]);
  });
  it("trusts the engine when a lane is already valid", () => {
    const lanes = [lane(["left"], true), lane(["through"])];
    expect(resolveRecommendedLanes(lanes, { type: "turn", modifier: "right" })).toBe(lanes);
  });

  it("does not override rejection even for an exact turn match", () => {
    const lanes = [lane(["left"]), lane(["through"]), lane(["right"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([false, false, false]);
    expect(out[0].active).toBeUndefined();
  });

  it("does not infer branch identity from the same side", () => {
    const lanes = [lane(["slight left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out[0].valid).toBe(false);
  });

  it("retains rejected through lanes for a straight maneuver", () => {
    const lanes = [lane(["left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "straight" });
    expect(out.map((l) => l.valid)).toEqual([false, false]);
  });

  it("returns [] for no lanes", () => {
    expect(resolveRecommendedLanes(undefined, { type: "turn", modifier: "left" })).toEqual([]);
  });

  it("does not invent through recommendations for a keep maneuver", () => {
    const lanes = [lane(["through"]), lane(["through"]), lane(["slight_right"])];
    const out = resolveRecommendedLanes(lanes, { type: "keep", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([false, false, false]);
  });
});

describe("junctionPhotoApproachMeters", () => {
  it("shows the photo about half a minute out, not the whole guidance window", () => {
    // 30 s at ~120 km/h, where the gantry has already been up for 2970 m.
    expect(junctionPhotoApproachMeters("driving", 33)).toBe(990);
    expect(junctionPhotoApproachMeters("driving", 33)).toBeLessThan(
      guidanceApproachMeters("driving", 33),
    );
  });

  it("keeps a floor so a slow approach still shows the photo in time", () => {
    expect(junctionPhotoApproachMeters("driving", 0)).toBe(300);
  });

  it("never outlasts the guidance window it sits inside", () => {
    for (const speed of [0, 5, 14, 25, 33, 45]) {
      expect(junctionPhotoApproachMeters("driving", speed)).toBeLessThanOrEqual(
        guidanceApproachMeters("driving", speed),
      );
    }
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
    // 420 m = 30 s × 14 m/s reference.
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 200)).toBe(true);
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 800)).toBe(false);
  });
});

it("keeps contradictory preferred/rejected lane evidence in conflict", () => {
  const result = resolveLaneGuidance([{ indications: ["through"], valid: false, preferred: true }]);
  expect(result.state).toBe("conflict");
  expect(result.preferredLanes).toEqual([]);
  expect(result.usableLanes).toEqual([]);
});
