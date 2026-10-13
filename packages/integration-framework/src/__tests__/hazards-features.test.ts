import { describe, expect, it } from "vitest";
import { resolveContributors } from "../contributors";
import { captureHazardFeatures } from "../hazards-features";

const source = { sourceId: "a", name: "Current A" };
const resolve = (evidence: Parameters<typeof resolveContributors>[0]) =>
  resolveContributors(evidence, (id) => (id === source.sourceId ? source : undefined));

describe("hazard feature acquisition", () => {
  it("copies canonical receipt metadata as well as the serialized worker receipt", () => {
    const captured = [
      { sourceId: "a", name: "Captured A", publisher: { name: "Original operator" } },
    ];
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { contributors: captured, sources: ["a"] },
        },
      ],
    };
    const result = captureHazardFeatures(
      collection,
      resolve,
      (feature) => feature.properties?.sources ?? [],
    );
    captured[0]!.publisher.name = "Changed operator";
    expect(result.features[0]?.properties?.contributors[0].publisher.name).toBe(
      "Original operator",
    );
    expect(JSON.parse(result.features[0]?.properties?._mapAttributions)[0].publisher.name).toBe(
      "Original operator",
    );
  });

  it("keeps an explicit empty receipt and unknown identities from expanding to a collection supplier", () => {
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { contributors: [], sources: ["a"] },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: { sources: ["unknown"] },
        },
      ],
    };
    const result = captureHazardFeatures(
      collection,
      resolve,
      (feature) => feature.properties?.sources ?? [],
    );
    expect(result.features.map((feature) => feature.properties?._mapAttributions)).toEqual([
      "[]",
      "[]",
    ]);
    expect(collection.features[0]?.properties?._mapAttributions).toBeUndefined();
  });
});
