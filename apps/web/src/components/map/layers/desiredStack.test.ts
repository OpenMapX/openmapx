import { afterEach, describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import { clearDesired, findMissingLayers, recordDesired } from "./desiredStack";

afterEach(() => {
  clearDesired("a");
  clearDesired("b");
});

describe("desiredStack", () => {
  it("reports nothing when everything intended is on the map", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addSource("s", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    fake.map.addLayer({ id: "l", type: "circle", source: "s" } as never);
    recordDesired("a", { sourceIds: ["s"], layerIds: ["l"] });
    expect(findMissingLayers(fake.map)).toEqual([]);
  });

  it("reports a layer that should be drawing and is not", () => {
    const fake = createFakeMap({ styleLoaded: true });
    recordDesired("a", { sourceIds: ["s"], layerIds: ["l"] });
    expect(findMissingLayers(fake.map)).toEqual([{ key: "a", missing: ["source:s", "layer:l"] }]);
  });

  it("forgets a group that has been cleared", () => {
    const fake = createFakeMap({ styleLoaded: true });
    recordDesired("a", { sourceIds: ["s"], layerIds: ["l"] });
    clearDesired("a");
    expect(findMissingLayers(fake.map)).toEqual([]);
  });
});
