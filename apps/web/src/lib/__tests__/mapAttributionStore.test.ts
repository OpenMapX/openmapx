import type { Attribution } from "@openmapx/mobility-core/attribution";
import { beforeEach, describe, expect, it } from "vitest";
import { flattenAttributions, useMapAttributionStore } from "../mapAttributionStore";

const osm: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
};
const maptiler: Attribution = {
  sourceId: "maptiler",
  name: "© MapTiler",
  url: "https://www.maptiler.com/copyright/",
};
const ocm: Attribution = {
  sourceId: "ocm",
  name: "OpenChargeMap",
  url: "https://openchargemap.org",
};

describe("useMapAttributionStore", () => {
  beforeEach(() => {
    useMapAttributionStore.setState({ entries: {} });
  });

  it("registers a layer's attributions and flattens to a deduplicated list", () => {
    useMapAttributionStore.getState().set("basemap", [maptiler, osm]);
    const flat = flattenAttributions(useMapAttributionStore.getState().entries);
    expect(flat.map((a) => a.sourceId)).toEqual(["maptiler", "openstreetmap"]);
  });

  it("removes a layer's contribution on remove()", () => {
    useMapAttributionStore.getState().set("basemap", [maptiler, osm]);
    useMapAttributionStore.getState().set("ev", [ocm, osm]);
    useMapAttributionStore.getState().remove("basemap");
    const flat = flattenAttributions(useMapAttributionStore.getState().entries);
    expect(flat.map((a) => a.sourceId)).toEqual(["ocm", "openstreetmap"]);
  });

  it("dedupes by sourceId across layers, preserving first-seen order", () => {
    useMapAttributionStore.getState().set("basemap", [maptiler, osm]);
    useMapAttributionStore.getState().set("ev", [ocm, osm]);
    const flat = flattenAttributions(useMapAttributionStore.getState().entries);
    expect(flat.map((a) => a.sourceId)).toEqual(["maptiler", "openstreetmap", "ocm"]);
  });

  it("treats setting the same content as a no-op (referential stability)", () => {
    useMapAttributionStore.getState().set("basemap", [maptiler]);
    const before = useMapAttributionStore.getState().entries;
    useMapAttributionStore.getState().set("basemap", [maptiler]);
    const after = useMapAttributionStore.getState().entries;
    expect(after).toBe(before);
  });

  it("skips entries with missing sourceId during flatten", () => {
    useMapAttributionStore
      .getState()
      .set("layer", [{ sourceId: "", name: "Bad" } as unknown as Attribution, osm]);
    const flat = flattenAttributions(useMapAttributionStore.getState().entries);
    expect(flat.map((a) => a.sourceId)).toEqual(["openstreetmap"]);
  });

  it("returns the empty list when no layers are registered", () => {
    expect(flattenAttributions({})).toEqual([]);
  });
});
