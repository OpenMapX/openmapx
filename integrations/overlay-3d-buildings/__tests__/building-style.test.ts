import { createRequire } from "node:module";
import type * as maplibregl from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  buildingExtrusionColor,
  contactShadowPaint,
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

function evaluateNumber(
  expression: maplibregl.ExpressionSpecification,
  properties: Record<string, unknown>,
): number {
  const parsed = createExpression(expression, {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  });
  if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
  return (
    parsed.value as { evaluate: (globals: { zoom: number }, feature: unknown) => number }
  ).evaluate({ zoom: 17 }, { type: "Polygon", properties });
}

function mapWithStyle(style: maplibregl.StyleSpecification): maplibregl.Map {
  return { getStyle: () => style } as unknown as maplibregl.Map;
}

describe("3D building style compatibility", () => {
  it.each([
    ["roofs", "Building"],
    ["buildings-3d", "structures"],
  ])(
    "recognizes the same provider building geometry as basemap sanitization: %s",
    (id, sourceLayer) => {
      const map = mapWithStyle({
        version: 8,
        sources: { city: { type: "vector", url: "https://example.test/tiles.json" } },
        layers: [
          {
            id: "shipbuilding-monument",
            type: "fill-extrusion",
            source: "city",
            "source-layer": "landmark",
          },
          { id, type: "fill", source: "city", "source-layer": sourceLayer },
        ],
      });
      expect(findBuildingSourceReference(map)).toEqual({ source: "city", sourceLayer });
    },
  );

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

  it.each([
    ["OpenMapTiles", { render_height: 18 }, { render_min_height: 6 }, 18, 6],
    ["common metre fields", { height: "12" }, { min_height: "4" }, 12, 4],
    ["OSM level fields", { "building:levels": 5 }, { "building:min_level": 2 }, 15, 6],
    ["short level fields", { levels: 4 }, { min_level: 1 }, 12, 3],
    ["missing fields", {}, {}, 3, 0],
    ["invalid fields", { height: "unknown" }, { min_height: "unknown" }, 3, 0],
    [
      "provider precedence",
      { render_height: 18, height: 30, "building:levels": 20 },
      { render_min_height: 6, min_height: 9, "building:min_level": 5 },
      18,
      6,
    ],
  ] as const)("evaluates %s as compatible height and base metres", (_name, height, base, h, b) => {
    expect(evaluateNumber(EXTRUSION_HEIGHT, height)).toBe(h);
    expect(evaluateNumber(EXTRUSION_BASE, base)).toBe(b);
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

  it("lifts an untagged roof without tinting it", () => {
    const [red, green, blue] = evaluateColor(buildingExtrusionColor("#e0e0e0"), {});
    // Luminance 0.878 lifts 26.4% of the way to white.
    for (const channel of [red, green, blue])
      expect(Math.abs(channel - 232.17)).toBeLessThanOrEqual(1);
  });

  it("treats an unparseable tag like an untagged building", () => {
    const color = buildingExtrusionColor(lightRoof);
    expect(evaluateColor(color, { colour: "mocassin" })).toEqual(evaluateColor(color, {}));
  });

  it("lifts a light roof towards white and tints it more softly", () => {
    const [red, green, blue] = evaluateColor(buildingExtrusionColor("#e0e0e0"), {
      colour: "#ff0000",
    });
    // Lifted roof 232.17, tag weight 0.08 + 0.17 × 0.878 = 0.229.
    expect(Math.abs(red - (0.2293 * 255 + 0.7707 * 232.17))).toBeLessThanOrEqual(1);
    expect(Math.abs(green - 0.7707 * 232.17)).toBeLessThanOrEqual(1);
    expect(Math.abs(blue - 0.7707 * 232.17)).toBeLessThanOrEqual(1);
  });

  it("barely lifts a dark roof", () => {
    const [red, green] = evaluateColor(buildingExtrusionColor("#202020"), { colour: "#ff0000" });
    // Luminance 0.1255: lift 0.0376 gives 40.4, tag weight 0.1013.
    expect(Math.abs(red - (0.1013 * 255 + 0.8987 * 40.39))).toBeLessThanOrEqual(1);
    expect(Math.abs(green - 0.8987 * 40.39)).toBeLessThanOrEqual(1);
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
    const untagged = evaluateColor(buildingExtrusionColor(lightRoof), {});
    expect(evaluateColor(buildingExtrusionColor(lightRoof), { colour: "#d48741" })).not.toEqual(
      untagged,
    );
    // The fallback roof #d4d0cc is lifted like any light roof.
    const [red, green, blue] = evaluateColor(buildingExtrusionColor(EXTRUSION_COLOR), {
      render_height: 0,
    });
    expect(red).toBeGreaterThan(212);
    expect(green).toBeGreaterThan(208);
    expect(blue).toBeGreaterThan(204);
  });
});

describe("3D building contact shadow", () => {
  const opacityPeak = (paint: ReturnType<typeof contactShadowPaint>) =>
    (paint?.["line-opacity"] as unknown[]).at(-1);

  it("gives the contact shadow a stronger rim on a dark style", () => {
    expect(opacityPeak(contactShadowPaint("#202020", 16.5))).toBe(0.2);
    expect(opacityPeak(contactShadowPaint("#e0e0e0", 16.5))).toBe(0.12);
    expect(opacityPeak(contactShadowPaint(null, 16.5))).toBe(0.12);
    expect(opacityPeak(contactShadowPaint("hsl(0, 0%, 10%)", 16.5))).toBe(0.12);
  });

  it("fades in with the extrusions and blurs as it widens", () => {
    const paint = contactShadowPaint("#e0e0e0", 16.5);
    expect(paint?.["line-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      16.5,
      0,
      17,
      0.12,
    ]);
    const ramp = ["interpolate", ["exponential", 2], ["zoom"], 17, 3, 20, 24];
    expect(paint?.["line-width"]).toEqual(ramp);
    expect(paint?.["line-blur"]).toEqual(ramp);
    expect(paint?.["line-color"]).toBe("#000000");
  });
});
