import type * as maplibregl from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { EXTRUSION_BASE, EXTRUSION_HEIGHT, findBuildingSourceReference } from "../building-style";

function mapWithStyle(style: maplibregl.StyleSpecification): maplibregl.Map {
  return { getStyle: () => style } as unknown as maplibregl.Map;
}

describe("3D building style compatibility", () => {
  it("selects the vector source referenced by a visible building layer", () => {
    const map = mapWithStyle({
      version: 8,
      sources: {
        unrelated: { type: "vector", url: "mapbox://unrelated" },
        hiddenBuildings: { type: "vector", url: "mapbox://hidden" },
        city: { type: "vector", url: "mapbox://city" },
      },
      layers: [
        {
          id: "hidden-buildings",
          type: "fill",
          source: "hiddenBuildings",
          "source-layer": "building",
          layout: { visibility: "none" },
        },
        {
          id: "city-buildings",
          type: "fill",
          source: "city",
          "source-layer": "buildings",
        },
      ],
    });

    expect(findBuildingSourceReference(map)).toEqual({
      source: "city",
      sourceLayer: "buildings",
    });
  });

  it("falls back to a hidden building layer but never to an unrelated vector source", () => {
    const hiddenMap = mapWithStyle({
      version: 8,
      sources: {
        unrelated: { type: "vector", url: "mapbox://unrelated" },
        city: { type: "vector", url: "mapbox://city" },
      },
      layers: [
        {
          id: "roads",
          type: "line",
          source: "unrelated",
          "source-layer": "road",
        },
        {
          id: "city-buildings",
          type: "fill",
          source: "city",
          "source-layer": "building",
          layout: { visibility: "none" },
        },
      ],
    });
    const unrelatedMap = mapWithStyle({
      version: 8,
      sources: { unrelated: { type: "vector", url: "mapbox://unrelated" } },
      layers: [
        {
          id: "roads",
          type: "line",
          source: "unrelated",
          "source-layer": "road",
        },
      ],
    });

    expect(findBuildingSourceReference(hiddenMap)).toEqual({
      source: "city",
      sourceLayer: "building",
    });
    expect(findBuildingSourceReference(unrelatedMap)).toBeNull();
  });

  it("includes OpenMapTiles, common height fields, level fallbacks, and safe defaults", () => {
    expect(JSON.stringify(EXTRUSION_HEIGHT)).toContain("render_height");
    expect(JSON.stringify(EXTRUSION_HEIGHT)).toContain('"height"');
    expect(JSON.stringify(EXTRUSION_HEIGHT)).toContain("building:levels");
    expect(EXTRUSION_HEIGHT.at(-1)).toBe(3);

    expect(JSON.stringify(EXTRUSION_BASE)).toContain("render_min_height");
    expect(JSON.stringify(EXTRUSION_BASE)).toContain("min_height");
    expect(JSON.stringify(EXTRUSION_BASE)).toContain("building:min_level");
    expect(EXTRUSION_BASE.at(-1)).toBe(0);
  });
});
