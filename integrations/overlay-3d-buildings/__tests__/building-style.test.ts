import { createRequire } from "node:module";
import type * as maplibregl from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  buildingExtrusionColor,
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingRoofColor,
  findBuildingSourceReference,
} from "../building-style";

const requireFromMapLibre = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const { createExpression } = requireFromMapLibre("@maplibre/maplibre-gl-style-spec") as {
  createExpression: (
    input: unknown,
    spec: unknown,
  ) => {
    result: string;
    value: unknown;
  };
};

type Rgba = [number, number, number, number];

/** Evaluate with MapLibre's own expression engine; returns 0–255 channels. */
function evaluateColor(
  expression: maplibregl.ExpressionSpecification,
  properties: Record<string, unknown>,
): Rgba {
  const parsed = createExpression(expression, {
    type: "color",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  });
  if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
  const { r, g, b, a } = (
    parsed.value as {
      evaluate: (
        globals: { zoom: number },
        feature: unknown,
      ) => { r: number; g: number; b: number; a: number };
    }
  ).evaluate({ zoom: 17 }, { type: "Polygon", properties });
  // MapLibre stores premultiplied 0–1 channels; every colour here is opaque.
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
}

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

  it("uses the top building fill color for the active vector source", () => {
    const map = mapWithStyle({
      version: 8,
      sources: { city: { type: "vector", url: "mapbox://city" } },
      layers: [
        {
          id: "building",
          type: "fill",
          source: "city",
          "source-layer": "building",
          paint: { "fill-color": "#777777" },
        },
        {
          id: "building-top",
          type: "fill",
          source: "city",
          "source-layer": "building",
          paint: { "fill-color": "#242b35" },
        },
      ],
    });

    expect(findBuildingRoofColor(map, { source: "city", sourceLayer: "building" })).toBe("#242b35");
    expect(findBuildingRoofColor(map, { source: "other", sourceLayer: "building" })).toBeNull();
  });
});

describe("3D building colour", () => {
  const lightRoof = "#e8e9ed";
  const darkRoof = "#242b35";

  it("keeps untagged and unparseable buildings on the basemap roof colour", () => {
    const color = buildingExtrusionColor(lightRoof);

    expect(evaluateColor(color, {})).toEqual([232, 233, 237, 1]);
    expect(evaluateColor(color, { colour: "mocassin" })).toEqual([232, 233, 237, 1]);
  });

  it("mixes a tagged colour into a light roof without replacing it", () => {
    const [red, green, blue] = evaluateColor(buildingExtrusionColor(lightRoof), {
      colour: "maroon",
    });

    expect(red).toBeGreaterThan(green);
    expect(green).toBeLessThan(200);
    expect(green).toBeGreaterThan(100);
    expect(blue).toBeLessThan(green + 5);
  });

  it("tints dark roofs much more gently than light ones", () => {
    const dark = evaluateColor(buildingExtrusionColor(darkRoof), { colour: "white" });
    const shift = dark[1] - 43;

    expect(shift).toBeGreaterThan(10);
    expect(shift).toBeLessThan(50);
  });

  it("accepts hex values and the height-graded fallback roof", () => {
    expect(evaluateColor(buildingExtrusionColor(lightRoof), { colour: "#d48741" })).not.toEqual([
      232, 233, 237, 1,
    ]);
    expect(evaluateColor(buildingExtrusionColor(EXTRUSION_COLOR), { render_height: 0 })).toEqual([
      212, 208, 204, 1,
    ]);
  });
});
