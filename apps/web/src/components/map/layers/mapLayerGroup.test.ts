import { afterEach, describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import { unregisterLayerSlot } from "./layerStack";
import { applyGroup, emptyApplied, type MapLayerGroup } from "./mapLayerGroup";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

function fc(lng: number) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [lng, 50] },
      },
    ],
  };
}

function group(data: unknown): MapLayerGroup {
  return {
    sources: { "g-src": { type: "geojson", data } as never },
    layers: [
      { id: "g-layer", type: "circle", source: "g-src", slot: "overlay-points", order: 0 } as never,
    ],
  };
}

afterEach(() => {
  unregisterLayerSlot("g-layer");
  unregisterLayerSlot("g-other");
});

describe("applyGroup", () => {
  it("creates the source with its data already in it", () => {
    const fake = createFakeMap({ styleLoaded: true });
    applyGroup(fake.map, group(fc(8)), emptyApplied());
    expect(fake.state.sources.get("g-src")?.data).toEqual(fc(8));
    expect(fake.state.layers.has("g-layer")).toBe(true);
  });

  it("pushes new data with setData rather than recreating the source", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const applied = applyGroup(fake.map, group(fc(8)), emptyApplied());
    const before = fake.state.sources.get("g-src");
    applyGroup(fake.map, group(fc(9)), applied);
    expect(fake.state.sources.get("g-src")).toBe(before);
    expect(fake.state.sources.get("g-src")?.data).toEqual(fc(9));
  });

  it("does nothing when the data reference is unchanged", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const data = fc(8);
    const applied = applyGroup(fake.map, group(data), emptyApplied());
    fake.state.sources.get("g-src")!.data = "sentinel";
    applyGroup(fake.map, group(data), applied);
    expect(fake.state.sources.get("g-src")?.data).toBe("sentinel");
  });

  it("re-adds a layer whose spec changed", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const first = group(EMPTY_FC);
    const applied = applyGroup(fake.map, first, emptyApplied());
    const changed: MapLayerGroup = {
      ...first,
      layers: [
        {
          id: "g-layer",
          type: "circle",
          source: "g-src",
          slot: "overlay-points",
          order: 0,
          paint: { "circle-radius": 12 },
        } as never,
      ],
    };
    applyGroup(fake.map, changed, applied);
    expect(fake.state.layers.get("g-layer")).toMatchObject({ paint: { "circle-radius": 12 } });
  });

  it("rebuilds everything, with data, from an empty applied record", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const desired = group(fc(8));
    applyGroup(fake.map, desired, emptyApplied());
    // What a style change leaves behind: nothing on the map, nothing applied.
    fake.state.sources.clear();
    fake.state.layers.clear();
    applyGroup(fake.map, desired, emptyApplied());
    expect(fake.state.sources.get("g-src")?.data).toEqual(fc(8));
    expect(fake.state.layers.has("g-layer")).toBe(true);
  });

  it("removes everything when the group becomes null", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const applied = applyGroup(fake.map, group(fc(8)), emptyApplied());
    const after = applyGroup(fake.map, null, applied);
    expect(fake.state.sources.has("g-src")).toBe(false);
    expect(fake.state.layers.has("g-layer")).toBe(false);
    expect(after.layerIds).toEqual([]);
  });

  it("drops a layer that is no longer in the descriptor", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const two: MapLayerGroup = {
      sources: { "g-src": { type: "geojson", data: EMPTY_FC } as never },
      layers: [
        {
          id: "g-layer",
          type: "circle",
          source: "g-src",
          slot: "overlay-points",
          order: 0,
        } as never,
        {
          id: "g-other",
          type: "circle",
          source: "g-src",
          slot: "overlay-points",
          order: 1,
        } as never,
      ],
    };
    const applied = applyGroup(fake.map, two, emptyApplied());
    applyGroup(fake.map, group(EMPTY_FC), applied);
    expect(fake.state.layers.has("g-other")).toBe(false);
    expect(fake.state.layers.has("g-layer")).toBe(true);
  });

  it("registers images only when they are missing", () => {
    const fake = createFakeMap({ styleLoaded: true });
    let calls = 0;
    const withImage: MapLayerGroup = {
      ...group(EMPTY_FC),
      images: {
        icon: () => {
          calls++;
          fake.map.addImage("icon", {} as never);
        },
      },
    };
    const applied = applyGroup(fake.map, withImage, emptyApplied());
    applyGroup(fake.map, withImage, applied);
    expect(calls).toBe(1);
  });
});
