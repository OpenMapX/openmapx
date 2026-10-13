import { beforeEach, describe, expect, it } from "vitest";
import {
  captureIsochroneContributors,
  captureReachabilityContributors,
} from "./travelTimeContributors";

const a = { sourceId: "a", name: "A", attributionText: "required old notice" };
const b = { sourceId: "b", name: "B" };
beforeEach(() => {
  a.name = "A";
  a.attributionText = "required old notice";
});
const polygon: GeoJSON.Feature = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
};

describe("travel time acquisition receipts", () => {
  it("captures sampled polygons independently of the reachability request", () => {
    const envelope = {
      data: { featureCollection: { type: "FeatureCollection" as const, features: [polygon] } },
      attributions: [a],
    };
    const captured = captureIsochroneContributors(envelope);
    a.name = "changed registry";
    expect(
      JSON.parse(captured.data.featureCollection.features[0]?.properties?._mapAttributions),
    ).toEqual([{ ...a, name: "A" }]);
    expect(polygon.properties).toEqual({});
    a.name = "A";
  });
  it("keeps authoritative empty feature receipts and does not assign a mixed envelope to unknown geometry", () => {
    const known: GeoJSON.Feature = { ...polygon, properties: { contributors: [] } };
    const result = captureIsochroneContributors({
      data: {
        featureCollection: { type: "FeatureCollection" as const, features: [known, polygon] },
      },
      attributions: [a, b],
    });
    expect(
      result.data.featureCollection.features.map((f) => JSON.parse(f.properties?._mapAttributions)),
    ).toEqual([[], []]);
  });
  it("uses native feature receipts instead of a newer envelope", () => {
    const original = { ...polygon, properties: { _mapAttributions: JSON.stringify([a]) } };
    const result = captureIsochroneContributors({
      data: { featureCollection: { type: "FeatureCollection" as const, features: [original] } },
      attributions: [b],
    });
    expect(
      JSON.parse(result.data.featureCollection.features[0]?.properties?._mapAttributions),
    ).toEqual([a]);
  });
  it("captures the independent estimated surface receipt with its response before caching", () => {
    const envelope = {
      data: { seeds: [{ lng: 0, lat: 0, arrivalSeconds: 10 }] },
      attributions: [a],
    };
    const result = captureReachabilityContributors(envelope);
    a.attributionText = "new notice";
    expect(result.data.contributors[0]?.attributionText).toBe("required old notice");
    a.attributionText = "required old notice";
  });
  it("honors an explicit surface contributors [] despite legacy envelope credits", () => {
    expect(
      captureReachabilityContributors({ data: { seeds: [], contributors: [] }, attributions: [a] })
        .data.contributors,
    ).toEqual([]);
  });
});
