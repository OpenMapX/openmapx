import type { ManeuverLane } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
import { resolveRecommendedLanes } from "../lanes";

const lane = (indications: string[], valid = false): ManeuverLane => ({ indications, valid });

describe("resolveRecommendedLanes", () => {
  it("trusts the engine when a lane is already valid", () => {
    const lanes = [lane(["left"], true), lane(["through"])];
    expect(resolveRecommendedLanes(lanes, "right")).toBe(lanes); // unchanged
  });

  it("recommends an exact-match lane when the engine didn't decide", () => {
    const lanes = [lane(["left"]), lane(["through"]), lane(["right"])];
    const out = resolveRecommendedLanes(lanes, "left");
    expect(out.map((l) => l.valid)).toEqual([true, false, false]);
    expect(out[0].active).toBe("left");
  });

  it("falls back to the same side when there's no exact match", () => {
    const lanes = [lane(["slight left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, "left");
    expect(out[0].valid).toBe(true); // slight left serves a left turn
  });

  it("marks through/straight lanes for a straight maneuver", () => {
    const lanes = [lane(["left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, "straight");
    expect(out.map((l) => l.valid)).toEqual([false, true]);
  });

  it("returns [] for no lanes", () => {
    expect(resolveRecommendedLanes(undefined, "left")).toEqual([]);
  });
});
