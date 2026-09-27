// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Layer = {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  minzoom?: number;
  filter?: unknown[];
  layout?: Record<string, unknown>;
};

function layers(name: string): Layer[] {
  const path = resolve(import.meta.dirname, `../../public/styles/${name}`);
  return (JSON.parse(readFileSync(path, "utf8")) as { layers: Layer[] }).layers;
}

describe("bundled basemap detail", () => {
  for (const styleName of ["openmapx-streets.json", "openmapx-dark.json"]) {
    it(`${styleName} labels house numbers and mountain summits when zoomed in`, () => {
      const styleLayers = layers(styleName);
      const houseNumbers = styleLayers.find((layer) => layer.id === "house-number");
      expect(houseNumbers).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "housenumber",
        minzoom: 17,
        layout: { "text-field": ["get", "housenumber"] },
      });

      const peaks = styleLayers.find((layer) => layer.id === "mountain-peak");
      expect(peaks).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "mountain_peak",
      });
      expect(peaks?.layout?.["text-field"]).toEqual([
        "concat",
        ["get", "name"],
        ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
      ]);
    });

    it(`${styleName} distinguishes recreation and natural ground cover`, () => {
      const styleLayers = layers(styleName);
      expect(styleLayers.find((layer) => layer.id === "landuse-recreation")).toMatchObject({
        type: "fill",
        "source-layer": "landuse",
        filter: ["in", "class", "pitch", "playground", "stadium"],
      });
      expect(styleLayers.find((layer) => layer.id === "landcover-rock")).toMatchObject({
        type: "fill",
        "source-layer": "landcover",
        filter: ["==", "class", "rock"],
      });
      expect(styleLayers.find((layer) => layer.id === "landcover-wetland")).toMatchObject({
        type: "fill",
        "source-layer": "landcover",
        filter: ["==", "class", "wetland"],
      });
    });
  }
});
