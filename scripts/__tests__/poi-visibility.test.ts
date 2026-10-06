import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Use the exact expression engine installed with the renderer, so a stale
// generated style or invalid filter cannot pass a policy-helper-only test.
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const rendererRequire = createRequire(webRequire.resolve("maplibre-gl/package.json"));
const { featureFilter, validateStyleMin } = rendererRequire("@maplibre/maplibre-gl-style-spec") as {
  featureFilter: (
    filter: unknown,
    rootKey: string,
  ) => {
    filter: (globals: { zoom: number }, feature: { type: number; properties: object }) => boolean;
  };
  validateStyleMin: (style: unknown) => { message: string }[];
};

type Layer = {
  id: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
};

for (const file of ["openmapx-streets.json", "openmapx-dark.json"]) {
  const style = JSON.parse(
    readFileSync(new URL(`../../apps/web/public/styles/${file}`, import.meta.url), "utf8"),
  ) as { layers: Layer[]; glyphs: string };
  const layers = style.layers.filter(
    (layer) => layer.id.startsWith("poi-level-") || layer.id === "poi-neighborhood-business",
  );
  const compiled = layers.map((layer) => ({
    layer,
    accepts: featureFilter(layer.filter, `layers.${layer.id}.filter`).filter,
  }));
  const eligible = (zoom: number, properties: Record<string, unknown>) =>
    compiled.filter(
      ({ layer, accepts }) =>
        zoom >= (layer.minzoom ?? 0) &&
        zoom < (layer.maxzoom ?? 24) &&
        accepts({ zoom }, { type: 1, properties }),
    ).length;

  describe(file, () => {
    it.each([
      ["cafe", 14, 8],
      ["restaurant", 15, 24],
      ["shop", 14, 4],
      ["grocery", 15, 12],
    ])("introduces a named %s at zoom %s without duplicating it", (poiClass, zoom, rank) => {
      expect(eligible(Number(zoom), { class: poiClass, name: "Destination", rank })).toBe(1);
    });

    it.each([
      ["cafe", 14, 9],
      ["restaurant", 15, 25],
      ["shop", 14, 5],
      ["grocery", 15, 13],
    ])("keeps lower-priority %s hidden at zoom %s", (poiClass, zoom, rank) => {
      expect(eligible(Number(zoom), { class: poiClass, name: "Destination", rank })).toBe(0);
    });

    it("keeps unnamed, non-ground-level, and unranked businesses out of early browsing", () => {
      for (const properties of [
        { class: "cafe", rank: 1 },
        { class: "cafe", name: "", rank: 1 },
        { class: "cafe", name: null, rank: 1 },
        { class: "shop", name: "Upstairs", rank: 1, level: 1 },
        { class: "restaurant", name: "Unranked" },
      ]) {
        expect(eligible(15, properties)).toBe(0);
      }
      expect(eligible(13.9, { class: "cafe", name: "Destination", rank: 1 })).toBe(0);
    });

    it("does not introduce parking, street furniture, or small transit stops early", () => {
      for (const poiClass of ["parking", "waste_basket", "bus", "bank", "fast_food"]) {
        expect(eligible(15, { class: poiClass, name: "Routine point", rank: 1 })).toBe(0);
      }
    });

    it("retains the existing close-zoom progression", () => {
      expect(eligible(16, { class: "restaurant", name: "Destination", rank: 25 })).toBe(1);
      expect(eligible(16, { class: "restaurant", name: "Destination", rank: 26 })).toBe(0);
      expect(eligible(17, { class: "restaurant", name: "Destination", rank: 115 })).toBe(1);
      expect(eligible(16, { class: "parking", name: "Car park", rank: 12 })).toBe(1);
    });

    it("retains landmark priority and collision avoidance", () => {
      const landmark = style.layers.findIndex((layer) => layer.id === "poi-landmark");
      expect(landmark).toBeGreaterThan(
        style.layers.findIndex((layer) => layer.id === "poi-level-1"),
      );
      for (const layer of layers) {
        expect(layer.layout?.["icon-allow-overlap"]).not.toBe(true);
        expect(layer.layout?.["text-allow-overlap"]).not.toBe(true);
      }
      const properties = {
        class: "museum",
        name: "Landmark",
        rank: 1,
        "name:fr": "Landmark",
        "name:es": "Landmark",
        "name:it": "Landmark",
        "name:ja": "Landmark",
        "name:zh": "Landmark",
        "name:ar": "Landmark",
      };
      expect(eligible(15, properties)).toBe(0);
      expect(
        featureFilter(style.layers[landmark].filter, "landmark.filter").filter(
          { zoom: 15 },
          { type: 1, properties },
        ),
      ).toBe(true);
    });

    it("gives existing cultural POIs first claim on label space", () => {
      const earlyIndex = style.layers.findIndex(
        (layer) => layer.id === "poi-neighborhood-business",
      );
      expect(earlyIndex).toBeGreaterThanOrEqual(0);
      expect(earlyIndex).toBeLessThan(
        style.layers.findIndex((layer) => layer.id === "poi-level-3"),
      );
      const properties = { class: "cafe", name: "New business", rank: 1 };
      for (const { layer, accepts } of compiled.filter(({ layer }) =>
        layer.id.startsWith("poi-level-"),
      )) {
        expect(accepts({ zoom: 15 }, { type: 1, properties }), layer.id).toBe(false);
      }
    });

    it("is valid after the runtime fills the glyph URL", () => {
      expect(
        validateStyleMin({ ...style, glyphs: "https://fonts.example/{fontstack}/{range}.pbf" }),
      ).toEqual([]);
    });
  });
}
