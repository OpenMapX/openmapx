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

    it(`${styleName} names protected and local parks without duplicate POI labels`, () => {
      const styleLayers = layers(styleName);
      expect(styleLayers.find((layer) => layer.id === "park-name")).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "park",
        minzoom: 7,
        filter: ["all", ["==", "$type", "Point"], ["has", "name"]],
        layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]] },
      });
      expect(styleLayers.find((layer) => layer.id === "poi-park-name")).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 14,
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["==", "class", "park"],
          ["has", "name"],
          ["any", ["!has", "level"], ["==", "level", 0]],
        ],
        layout: {
          "icon-image": "park_11",
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        },
      });
      for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
        const genericPoi = styleLayers.find((layer) => layer.id === id);
        const namedParkExclusion =
          id === "poi-level-1"
            ? ["!=", "class", "park"]
            : ["any", ["!=", "class", "park"], ["!has", "name"]];
        expect(genericPoi?.filter?.map((entry) => JSON.stringify(entry))).toContain(
          JSON.stringify(namedParkExclusion),
        );
        expect(styleLayers.findIndex((layer) => layer.id === "poi-park-name")).toBeGreaterThan(
          styleLayers.findIndex((layer) => layer.id === id),
        );
      }
    });
  }
});
