import type { Attribution } from "@openmapx/mobility-core/attribution";
import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { flowFeatureContributorKey, flowFeatureContributors } from "./flowContributors";
import { createVectorTileCoverageContributorResolver } from "./vectorTileCoverageContributors";

const receipt = (notice: string): Attribution => ({
  sourceId: "same-source",
  name: "Supplier",
  attributionText: notice,
});
const properties = (notice: string, ratio: number | null = 0.5) => ({
  speed_ratio: ratio,
  field_contributors: JSON.stringify({
    geometry: [],
    ratio: [receipt(notice)],
    los: [receipt("Declared LOS")],
    confidence: [],
  }),
});
function fixture(count = 1) {
  const fake = createFakeMap({ zoom: 8, styleLoaded: false });
  fake.map.addSource("flow", { type: "vector", tiles: ["https://tiles.test/{z}/{x}/{y}"] });
  for (const id of ["casing", "color"])
    fake.map.addLayer({ id, type: "line", source: "flow", "source-layer": "segments", minzoom: 6 });
  for (const id of ["casing", "color"])
    Object.assign(fake.map.getLayer(id) ?? {}, { sourceLayer: "segments" });
  let data = properties("First notice");
  const feature = vi.fn(() => ({ properties: data }));
  const index = () => ({
    rawTileData: new ArrayBuffer(8),
    encoding: "mvt",
    loadVTLayers: () => ({ segments: { length: count, feature } }),
  });
  const buckets = new Set(["casing", "color"]);
  const tile = {
    hasData: () => true,
    latestFeatureIndex: index(),
    getBucket: (layer: { id: string }) =>
      buckets.has(layer.id) ? { uploaded: true, isEmpty: () => false } : undefined,
  };
  let visible = [1, 2]; // Two world copies of the same retained raw tile.
  let source = fake.map.getSource("flow");
  const evaluated = new Map<string, unknown>();
  Object.assign(fake.map, {
    style: {
      getLayer: (id: string) => ({
        ...fake.map.getLayer(id),
        paint: {
          get: (key: string) => ({
            constantOr: () =>
              evaluated.get(`${id}:${key}`) ?? fake.map.getPaintProperty(id, key as "line-opacity"),
          }),
        },
      }),
      tileManagers: {
        flow: {
          getSource: () => source,
          getVisibleCoordinates: () => visible,
          getTile: () => tile,
        },
      },
    },
  });
  let projections = 0;
  const resolve = (p: Record<string, unknown>, layerId: string) => {
    projections++;
    return flowFeatureContributors(p, layerId === "casing" ? "casing" : "color");
  };
  const read = createVectorTileCoverageContributorResolver({
    sourceId: "flow",
    sourceLayer: "segments",
    layerIds: ["casing", "color"],
    featureContributorKey: (p) => flowFeatureContributorKey(p, "color"),
    resolveFeatureContributors: resolve,
  });
  return {
    fake,
    tile,
    feature,
    projections: () => projections,
    buckets,
    evaluated,
    read: () => read(fake.map),
    replace: (notice: string, ratio: number | null = 0.5) => {
      data = properties(notice, ratio);
      tile.latestFeatureIndex = index();
    },
    reparse: () => {
      tile.latestFeatureIndex = { ...tile.latestFeatureIndex };
    },
    hideTiles: () => {
      visible = [];
    },
    replaceSource: () => {
      source = {} as typeof source;
    },
  };
}

describe("conservative vector tile coverage credits", () => {
  it("scans dense properties once per payload and projects distinct receipts, without geometry queries", () => {
    const f = fixture(90_000);
    const query = vi.spyOn(f.fake.map, "queryRenderedFeatures");
    expect(f.read()).toEqual([receipt("First notice")]);
    expect(f.feature).toHaveBeenCalledTimes(90_000);
    expect(f.projections()).toBe(2);
    for (let i = 0; i < 20; i++) expect(f.read()).toEqual([receipt("First notice")]);
    f.reparse(); // Style worker reparse reuses the raw payload.
    expect(f.read()).toEqual([receipt("First notice")]);
    expect(f.feature).toHaveBeenCalledTimes(90_000);
    expect(f.projections()).toBe(2);
    expect(query).not.toHaveBeenCalled();
  });
  it("preserves distinct full receipts including retrieval time across records", () => {
    const f = fixture(2);
    let n = 0;
    f.feature.mockImplementation(() => ({
      properties: {
        speed_ratio: 0.5,
        field_contributors: JSON.stringify({
          geometry: [],
          confidence: [],
          ratio: [
            { ...receipt("Same notice"), retrievedAt: ++n % 2 ? "2026-10-15" : "2026-10-16" },
          ],
        }),
      },
    }));
    expect(f.read()).toEqual([
      { ...receipt("Same notice"), retrievedAt: "2026-10-15" },
      { ...receipt("Same notice"), retrievedAt: "2026-10-16" },
    ]);
  });
  it("keeps retained receipts, replaces changed same-source notices, and respects ratio versus LOS fields", () => {
    const f = fixture();
    const first = f.read();
    if (!first[0]) throw new Error("Expected captured supplier");
    first[0].attributionText = "Mutated caller copy";
    expect(f.read()).toEqual([receipt("First notice")]);
    // A pending/failed refresh retaining drawable raw data keeps its credit.
    expect(f.read()).toEqual([receipt("First notice")]);
    f.replace("Changed notice");
    expect(f.read()).toEqual([receipt("Changed notice")]);
    f.replace("Ratio must not leak", null);
    expect(f.read()).toEqual([receipt("Declared LOS")]);
  });
  it("uses current layer gates, uploaded nonempty buckets, overzoom and current tile coverage", () => {
    const f = fixture();
    f.fake.state.zoom = 20; // Beyond the source maxzoom is still renderable.
    expect(f.read()).toEqual([receipt("First notice")]);
    f.fake.map.setLayoutProperty("color", "visibility", "none");
    expect(f.read()).toEqual([]); // Explicit empty geometry, never invent OSM.
    f.fake.map.setLayoutProperty("color", "visibility", "visible");
    f.fake.map.setPaintProperty("color", "line-opacity", 0);
    expect(f.read()).toEqual([]);
    f.fake.map.setPaintProperty("color", "line-opacity", 1);
    f.fake.state.zoom = 5;
    expect(f.read()).toEqual([]);
    f.fake.state.zoom = 8;
    f.buckets.delete("color");
    expect(f.read()).toEqual([]);
    f.buckets.add("color");
    expect(f.read()).toEqual([receipt("First notice")]);
    const getBucket = f.tile.getBucket;
    f.tile.getBucket = () => ({ uploaded: false, isEmpty: () => false });
    expect(f.read()).toEqual([]);
    f.tile.getBucket = () => ({ uploaded: true, isEmpty: () => true });
    expect(f.read()).toEqual([]);
    f.tile.getBucket = getBucket;
    f.hideTiles();
    expect(f.read()).toEqual([]);
  });
  it("retains credit during a fade toward zero until evaluated paint disappears", () => {
    const f = fixture();
    f.fake.map.setPaintProperty("color", "line-opacity", 0);
    f.evaluated.set("color:line-opacity", 0.5);
    expect(f.read()).toEqual([receipt("First notice")]);
    f.evaluated.set("color:line-opacity", 0);
    expect(f.read()).toEqual([]);
  });
  it("does not borrow data from a replaced source with the same ID", () => {
    const f = fixture();
    expect(f.read()).toHaveLength(1);
    f.replaceSource();
    expect(f.read()).toEqual([]);
  });
});
