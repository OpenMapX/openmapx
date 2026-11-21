import { describe, expect, it } from "vitest";
import { findForestSource } from "../web/basemap-source";

const style = (sources: Record<string, unknown>, layers: unknown[]) => ({
  version: 8,
  sources,
  layers,
});
const layers = [
  { id: "background", type: "background" },
  { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water" },
  { id: "landcover-wood", type: "fill", source: "openmaptiles", "source-layer": "landcover" },
];

describe("forest basemap source", () => {
  it("finds the vector source with a landcover layer and reads its live templates", () => {
    const live = { type: "vector", tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"], maxzoom: 14 };
    expect(
      findForestSource(style({ openmaptiles: { type: "vector", url: "x" } }, layers), (id) =>
        id === "openmaptiles" ? live : undefined,
      ),
    ).toEqual({ templates: live.tiles, maxzoom: 14 });
  });

  it("accepts page-relative templates and defaults the maxzoom to 14", () => {
    expect(
      findForestSource(style({ openmaptiles: { type: "vector" } }, layers), () => ({
        type: "vector",
        tiles: ["/tiles/data/openmapx/{z}/{x}/{y}.pbf"],
      })),
    ).toEqual({ templates: ["/tiles/data/openmapx/{z}/{x}/{y}.pbf"], maxzoom: 14 });
  });

  it.each([["pmtiles://archive/{z}/{x}/{y}"], ["openmapx-buildings://{z}/{x}/{y}"]])(
    "refuses a %s template",
    (template) => {
      expect(
        findForestSource(style({ openmaptiles: { type: "vector" } }, layers), () => ({
          type: "vector",
          tiles: [template],
        })),
      ).toBeNull();
    },
  );

  it("is null without a landcover layer or before the source has templates", () => {
    expect(findForestSource(style({}, layers.slice(0, 2)), () => undefined)).toBeNull();
    expect(
      findForestSource(style({ openmaptiles: { type: "vector" } }, layers), () => ({
        type: "vector",
      })),
    ).toBeNull();
    expect(findForestSource(undefined, () => undefined)).toBeNull();
  });
});
