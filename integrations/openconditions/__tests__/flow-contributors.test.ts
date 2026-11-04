import { describe, expect, it } from "vitest";
import { featureCollectionToRoadFlowSegments } from "../road-conditions/flow";

const a = { sourceId: "parent-a", name: "Captured A", publisher: { name: "Original publisher" } };
const b = { sourceId: "los-b", name: "LOS B" };
/** A rated value is derived: OpenConditions fused the readings and rated them against its baseline. */
const derived = <T extends object>(credit: T) => ({ ...credit, modified: true as const });

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
  it("credits the rated values as derived, but not the graph segment they are drawn on", () => {
    const graph = { sourceId: "osm", name: "OpenStreetMap" };
    const crowd = { sourceId: "crowd", name: "Contributors" };
    const [segment] = featureCollectionToRoadFlowSegments(
      body({ ratio: [a, crowd], geometry: [graph] }),
      "openconditions",
    );
    expect(segment.fieldContributors).toEqual({ ratio: [derived(a), crowd], geometry: [graph] });
  });
  it("keeps selected field receipts separately and copies them before caching", () => {
    const input = structuredClone(a);
    const [segment] = featureCollectionToRoadFlowSegments(
      body({ ratio: [input], los: [b], geometry: [] }),
      "openconditions",
    );
    input.name = "Catalogue changed";
    expect(segment.fieldContributors).toEqual({
      ratio: [derived(a)],
      los: [derived(b)],
      geometry: [],
    });
  });
  it("accepts MVT-compatible JSON and does not infer measurement feeds from rights dependencies", () => {
    const [segment] = featureCollectionToRoadFlowSegments(
      body(JSON.stringify({ ratio: [a], los: [] })),
      "openconditions",
    );
    expect(segment.fieldContributors).toEqual({ ratio: [derived(a)], los: [] });
    const [legacy] = featureCollectionToRoadFlowSegments(body(undefined), "openconditions");
    expect(legacy.fieldContributors).toBeUndefined();
  });
});
