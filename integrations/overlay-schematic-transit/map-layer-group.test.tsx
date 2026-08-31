import { describe, expect, it } from "vitest";
import { buildSchematicGroup, SCHEMATIC_SOURCE_ID } from "./map-layer-group";

describe("buildSchematicGroup", () => {
  const group = buildSchematicGroup("https://api.example.org", "tram", "octi");

  it("points the vector source at the API proxy without a .mvt suffix", () => {
    const source = group.sources[SCHEMATIC_SOURCE_ID] as { type: string; tiles: string[] };
    expect(source.type).toBe("vector");
    expect(source.tiles).toEqual([
      "https://api.example.org/api/integrations/overlay-schematic-transit/tiles/tram/octi/{z}/{x}/{y}",
    ]);
    expect(source.tiles[0]).not.toMatch(/\.(mvt|pbf)$/);
  });

  it("declares the five layers in slot order: connectors, lines, station fill, station outline, labels", () => {
    expect(group.layers.map((l) => ({ id: l.id, type: l.type, slot: l.slot }))).toEqual([
      { id: "omx-schematic-transit-connections", type: "line", slot: "overlay-lines" },
      { id: "omx-schematic-transit-lines", type: "line", slot: "overlay-lines" },
      { id: "omx-schematic-transit-station-fill", type: "fill", slot: "overlay-points" },
      { id: "omx-schematic-transit-station-outline", type: "line", slot: "overlay-points" },
      { id: "omx-schematic-transit-station-labels", type: "symbol", slot: "overlay-markers" },
    ]);
  });

  it("rebuilds tile URLs when the variant changes", () => {
    const other = buildSchematicGroup("https://api.example.org", "rail", "geo");
    const source = other.sources[SCHEMATIC_SOURCE_ID] as { tiles: string[] };
    expect(source.tiles[0]).toContain("/tiles/rail/geo/");
  });
});
