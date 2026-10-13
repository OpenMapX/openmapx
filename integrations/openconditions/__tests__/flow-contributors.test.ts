import { describe, expect, it } from "vitest";
import { featureCollectionToRoadFlowSegments } from "../road-conditions/flow";

const a = { sourceId: "parent-a", name: "Captured A", publisher: { name: "Original publisher" } };
const b = { sourceId: "los-b", name: "LOS B" };

function body(fields: unknown) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [6, 51],
            [6.1, 51.1],
          ],
        },
        properties: {
          segment_id: "segment:f",
          speed_ratio: 0.5,
          los: "queuing",
          lineage_version: 1,
          field_contributors: fields,
        },
      },
    ],
  };
}

describe("OpenConditions captured flow contributors", () => {
  it("keeps selected field receipts separately and copies them before caching", () => {
    const input = structuredClone(a);
    const [segment] = featureCollectionToRoadFlowSegments(
      body({ ratio: [input], los: [b], geometry: [] }),
      "openconditions",
    );
    input.name = "Catalogue changed";
    expect(segment.fieldContributors).toEqual({ ratio: [a], los: [b], geometry: [] });
  });
  it("accepts MVT-compatible JSON and does not infer measurement feeds from rights dependencies", () => {
    const [segment] = featureCollectionToRoadFlowSegments(
      body(JSON.stringify({ ratio: [a], los: [] })),
      "openconditions",
    );
    expect(segment.fieldContributors).toEqual({ ratio: [a], los: [] });
    const [legacy] = featureCollectionToRoadFlowSegments(body(undefined), "openconditions");
    expect(legacy.fieldContributors).toBeUndefined();
  });
});
