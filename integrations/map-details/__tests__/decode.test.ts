import { describe, expect, it } from "vitest";
import { decodeLayers, wayIdOf } from "../web/derive/decode";
import { ALEXANDERPLATZ, fixtureBytes, GRUNEWALD, STREET_LAYERS, streetFixture } from "./fixtures";

describe("decodeLayers", () => {
  it("decodes the six street detail layers with typed properties", () => {
    const tile = streetFixture(ALEXANDERPLATZ);
    expect(tile.extent).toBe(4096);
    expect(Object.keys(tile.layers).sort()).toEqual([...STREET_LAYERS].sort());
    const roads = tile.layers.roads ?? [];
    expect(roads.length).toBeGreaterThan(10);
    for (const road of roads) {
      expect(road.type).toBe(2);
      expect(typeof road.props.class).toBe("string");
      expect(typeof road.props.oneway).toBe("number");
    }
    const lanes = roads.filter((road) => road.props.lanes !== undefined);
    expect(lanes.every((road) => Number.isInteger(road.props.lanes))).toBe(true);
    const rails = tile.layers.rails ?? [];
    expect(rails.some((rail) => rail.props.kind === "tram")).toBe(true);
    expect((tile.layers.furniture ?? []).every((f) => f.type === 1)).toBe(true);
  });

  it("decodeLayers keeps the feature id", () => {
    const roads = streetFixture(ALEXANDERPLATZ).layers.roads ?? [];
    expect(roads.length).toBeGreaterThan(0);
    // Planetiler writes OSM ways as osmId × 10 + 2.
    expect(roads.every((road) => typeof road.id === "number" && road.id % 10 === 2)).toBe(true);
    expect(roads.every((road) => (wayIdOf(road) ?? 0) > 0)).toBe(true);
  });

  it("wayIdOf reads Planetiler's osmId×10+2 ids", () => {
    expect(wayIdOf({ type: 2, geometry: [], props: {}, id: 189081302 })).toBe(18908130);
  });

  it("non-way feature ids give no way id", () => {
    expect(wayIdOf({ type: 1, geometry: [], props: {}, id: 189081301 })).toBeNull();
    expect(wayIdOf({ type: 3, geometry: [], props: {}, id: 189081303 })).toBeNull();
    expect(wayIdOf({ type: 2, geometry: [], props: {} })).toBeNull();
  });

  it("returns an empty list for a layer the tile does not have", () => {
    const tile = decodeLayers(fixtureBytes(GRUNEWALD), ["landcover", "missing"]);
    expect(tile.layers.missing).toEqual([]);
    expect((tile.layers.landcover ?? []).length).toBeGreaterThan(0);
    expect(tile.layers.landcover?.[0]?.geometry[0]?.[0]).toHaveLength(2);
  });
});
