import { describe, expect, it } from "vitest";
import { flowFeatureContributors } from "./flowContributors";

const geometry = { sourceId: "geometry", name: "Geometry publisher" };
const a = { sourceId: "ratio-a", name: "Ratio A" };
const b = { sourceId: "los-b", name: "LOS B" };
const confidence = { sourceId: "confidence", name: "Confidence publisher" };
const p = {
  speed_ratio: 0.5,
  current_kph: 20,
  free_flow_kph: 40,
  los: "queuing",
  confidence: "measured",
  field_contributors: JSON.stringify({
    geometry: [geometry],
    ratio: [a],
    los: [b],
    speed: [a],
    freeFlow: [geometry],
    confidence: [confidence],
  }),
};

describe("FLOW display contribution projection", () => {
  it("credits geometry only for casing and actual ratio plus opacity suppliers for color", () => {
    expect(flowFeatureContributors(p, "casing")).toEqual([geometry]);
    expect(flowFeatureContributors(p, "color")).toEqual([geometry, a, confidence]);
    expect(flowFeatureContributors({ ...p, speed_ratio: null }, "color")).toEqual([
      geometry,
      b,
      confidence,
    ]);
  });
  it("credits all actually present popup fields, not absent fields", () => {
    expect(flowFeatureContributors(p, "popup")).toEqual([geometry, a, b, confidence]);
    expect(
      flowFeatureContributors(
        {
          ...p,
          current_kph: null,
          free_flow_kph: null,
          speed_ratio: null,
          los: null,
          confidence: null,
        },
        "popup",
      ),
    ).toEqual([geometry]);
  });
  it("honors explicit empty geometry snapshots and never invents legacy measurement sources", () => {
    expect(
      flowFeatureContributors(
        { field_contributors: { geometry: [], ratio: [] }, speed_ratio: 0.5 },
        "color",
      ),
    ).toEqual([]);
    const legacy = flowFeatureContributors(
      { speed_ratio: 0.5, sources: ["unselected-b"] },
      "color",
    );
    expect(legacy.map((receipt) => receipt.sourceId)).toEqual(["openstreetmap"]);
  });
});
