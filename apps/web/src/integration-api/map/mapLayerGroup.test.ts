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
    const source = fake.state.sources.get("g-src");
    if (!source) throw new Error("expected the g-src source to be registered");
    source.data = "sentinel";
    applyGroup(fake.map, group(data), applied);
    expect(fake.state.sources.get("g-src")?.data).toBe("sentinel");
  });

  function withLayer(layer: Record<string, unknown>): MapLayerGroup {
    return {
      sources: { "g-src": { type: "geojson", data: EMPTY_FC } as never },
      layers: [
        {
          id: "g-layer",
          type: "circle",
          source: "g-src",
          slot: "overlay-points",
          order: 0,
          ...layer,
        } as never,
      ],
    };
  }

  it("re-adds a layer whose structure changed", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const applied = applyGroup(fake.map, withLayer({}), emptyApplied());
    applyGroup(fake.map, withLayer({ type: "heatmap" }), applied);
    expect(fake.state.layers.get("g-layer")).toMatchObject({ type: "heatmap" });
    expect(fake.state.counts.addLayer.get("g-layer")).toBe(2);
  });

  it("updates paint, layout, filter and zoom range on the live layer", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const applied = applyGroup(
      fake.map,
      withLayer({ paint: { "circle-radius": 4, "circle-color": "#000" }, minzoom: 4 }),
      emptyApplied(),
    );
    applyGroup(
      fake.map,
      withLayer({
        paint: { "circle-radius": 12 },
        layout: { visibility: "none" },
        filter: ["==", ["get", "kind"], "a"],
        minzoom: 6,
      }),
      applied,
    );

    expect(fake.state.counts.addLayer.get("g-layer")).toBe(1);
    expect(fake.state.counts.removeLayer.get("g-layer") ?? 0).toBe(0);
    expect(fake.map.getPaintProperty("g-layer", "circle-radius")).toBe(12);
    expect(fake.map.getPaintProperty("g-layer", "circle-color")).toBeUndefined();
    expect(fake.map.getLayoutProperty("g-layer", "visibility")).toBe("none");
    expect(fake.state.filters.get("g-layer")).toEqual(["==", ["get", "kind"], "a"]);
    expect(fake.state.layers.get("g-layer")).toMatchObject({ minzoom: 6, maxzoom: 24 });
  });

  it("leaves an unchanged layer untouched", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const spec = { paint: { "circle-radius": 4 }, filter: ["has", "id"] };
    const applied = applyGroup(fake.map, withLayer(spec), emptyApplied());
    applyGroup(fake.map, withLayer(structuredClone(spec)), applied);
    expect(fake.state.counts.setPaintProperty.get("g-layer") ?? 0).toBe(0);
    expect(fake.state.counts.setFilter.get("g-layer") ?? 0).toBe(0);
    expect(fake.state.counts.addLayer.get("g-layer")).toBe(1);
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

  it("starts a pending image load once per style, not once per pass", () => {
    const fake = createFakeMap({ styleLoaded: true });
    let calls = 0;
    const pending: MapLayerGroup = { ...group(EMPTY_FC), images: { icon: () => calls++ } };
    let applied = applyGroup(fake.map, pending, emptyApplied());
    applied = applyGroup(fake.map, pending, applied);
    applyGroup(fake.map, pending, applied);
    expect(calls).toBe(1);

    // A style change drops images; the rebuild starts from an empty record.
    applyGroup(fake.map, pending, emptyApplied());
    expect(calls).toBe(2);
  });
});
