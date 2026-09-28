// @vitest-environment node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const publicStyles = resolve(import.meta.dirname, "../../public/styles");
const requireFromMapLibre = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const { createExpression } = requireFromMapLibre("@maplibre/maplibre-gl-style-spec") as {
  createExpression: (
    input: unknown,
    rootKey: string,
  ) => {
    result: string;
    errors?: unknown[];
    value?: {
      evaluate: (
        globals: { zoom: number },
        feature: { type: "Point"; properties: { class: string; subclass?: string } },
        featureState: undefined,
        canonical: undefined,
        availableImages: string[],
      ) => { name: string; available: boolean } | null;
    };
  };
};

type Layer = {
  id: string;
  minzoom?: number;
  filter?: unknown;
  layout?: { "icon-image"?: unknown };
};
type Style = { layers: Layer[] };
type SpriteEntry = { x: number; y: number; width: number; height: number; pixelRatio: number };

function readStyle(name: string): Style {
  return JSON.parse(readFileSync(resolve(publicStyles, name), "utf8")) as Style;
}

function readSprite(name: string): Record<string, SpriteEntry> {
  return JSON.parse(readFileSync(resolve(publicStyles, name), "utf8")) as Record<
    string,
    SpriteEntry
  >;
}

function resolvedIcon(
  layer: Layer,
  poiClass: string,
  availableImages: string[],
  subclass?: string,
): string | null {
  const iconImage = layer.layout?.["icon-image"];
  if (typeof iconImage === "string") {
    const name = iconImage.replace("{class}", poiClass);
    return availableImages.includes(name) ? name : null;
  }

  const expression = createExpression(iconImage, `layers.${layer.id}.layout.icon-image`);
  expect(expression.errors).toBeUndefined();
  expect(expression.result).toBe("success");
  const image = expression.value?.evaluate(
    { zoom: 16 },
    { type: "Point", properties: { class: poiClass, ...(subclass ? { subclass } : {}) } },
    undefined,
    undefined,
    availableImages,
  );
  return image?.available ? image.name : null;
}

describe("bundled basemap POI sprites", () => {
  for (const spriteScale of ["", "@2x"]) {
    it(`resolves broad POI classes and specific subclasses in both styles with ${spriteScale || "1x"} sprites`, () => {
      const manifest = readSprite(`sprite${spriteScale}.json`);
      const availableImages = Object.keys(manifest);
      const png = readFileSync(resolve(publicStyles, `sprite${spriteScale}.png`));
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);

      for (const name of ["car_11", "bank_11", "toilet_11", "marker_11", "railway_11"]) {
        const entry = manifest[name];
        if (!entry) throw new Error(`${name} missing from ${spriteScale || "1x"} sprite`);
        expect(entry.x + entry.width).toBeLessThanOrEqual(width);
        expect(entry.y + entry.height).toBeLessThanOrEqual(height);
      }

      for (const styleName of ["openmapx-streets.json", "openmapx-dark.json"]) {
        const style = readStyle(styleName);
        for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
          const layer = style.layers.find((candidate) => candidate.id === id);
          if (!layer) throw new Error(`${id} missing from ${styleName}`);
          expect(resolvedIcon(layer, "parking", availableImages)).toBe("poi-parking");
          expect(resolvedIcon(layer, "atm", availableImages)).toBe("poi-atm");
          expect(resolvedIcon(layer, "toilets", availableImages)).toBe("poi-toilets");
          expect(resolvedIcon(layer, "office", availableImages)).toBe("poi-office");
          expect(resolvedIcon(layer, "unmapped_class", availableImages)).toBe("marker_11");
          expect(resolvedIcon(layer, "restaurant", availableImages)).toBe("poi-restaurant");
          expect(resolvedIcon(layer, "bus", availableImages, "bus_stop")).toBe("poi-bus");
          expect(resolvedIcon(layer, "school", availableImages, "kindergarten")).toBe("poi-school");
          expect(resolvedIcon(layer, "hospital", availableImages, "hospital")).toBe("poi-hospital");
          expect(resolvedIcon(layer, "grocery", availableImages, "supermarket")).toBe(
            "poi-grocery",
          );
          expect(resolvedIcon(layer, "shop", availableImages, "beauty")).toBe("poi-shop-beauty");
          expect(resolvedIcon(layer, "shop", availableImages, "florist")).toBe("poi-shop-florist");
          expect(resolvedIcon(layer, "shop", availableImages, "chemist")).toBe("poi-shop-chemist");
          expect(resolvedIcon(layer, "town_hall", availableImages, "community_centre")).toBe(
            "poi-town_hall-community_centre",
          );
          expect(resolvedIcon(layer, "railway", availableImages, "tram_stop")).toBe(
            "poi-railway-tram_stop",
          );
          expect(resolvedIcon(layer, "shop", availableImages, "unmapped_subclass")).toBe(
            "poi-shop",
          );
          for (const [poiClass, subclass, icon] of [
            ["motorcycle_parking", undefined, "poi-motorcycle_parking"],
            ["cycle_barrier", undefined, "poi-cycle_barrier"],
            ["toll_booth", undefined, "poi-toll_booth"],
            ["yoga", undefined, "poi-yoga"],
            ["table_tennis", undefined, "poi-table_tennis"],
            ["ice_rink", undefined, "poi-ice_rink"],
            ["climbing", undefined, "poi-climbing"],
            ["pitch", "table_tennis", "poi-pitch-table_tennis"],
            ["pitch", "basketball", "poi-pitch-basketball"],
            ["pitch", "tennis", "poi-pitch-tennis"],
            ["pitch", "soccer", "poi-pitch-soccer"],
            ["bar", "nightclub", "poi-bar-nightclub"],
          ] as const) {
            expect(resolvedIcon(layer, poiClass, availableImages, subclass)).toBe(icon);
          }
        }

        const railway = style.layers.find((candidate) => candidate.id === "poi-railway");
        if (!railway) throw new Error(`poi-railway missing from ${styleName}`);
        expect(resolvedIcon(railway, "railway", availableImages)).toBe("railway_11");

        const streetFixtures = style.layers.find(
          (candidate) => candidate.id === "poi-street-fixtures",
        );
        if (!streetFixtures) throw new Error(`poi-street-fixtures missing from ${styleName}`);
        expect(streetFixtures.minzoom).toBe(19);
        expect(resolvedIcon(streetFixtures, "waste_basket", availableImages)).toBe(
          "poi-waste_basket",
        );
        expect(resolvedIcon(streetFixtures, "bicycle_parking", availableImages)).toBe(
          "poi-bicycle_parking",
        );
        expect(resolvedIcon(streetFixtures, "motorcycle_parking", availableImages)).toBe(
          "poi-motorcycle_parking",
        );
        expect(resolvedIcon(streetFixtures, "cycle_barrier", availableImages)).toBe(
          "poi-cycle_barrier",
        );

        for (const name of [
          "poi-restaurant",
          "poi-shop-beauty",
          "poi-railway-tram_stop",
          "poi-waste_basket",
          "poi-bus",
          "poi-school",
          "poi-shop-florist",
          "poi-motorcycle_parking",
          "poi-cycle_barrier",
          "poi-pitch-table_tennis",
        ]) {
          const entry = manifest[name];
          if (!entry) throw new Error(`${name} missing from ${spriteScale || "1x"} sprite`);
          expect(entry.pixelRatio).toBe(spriteScale ? 2 : 1);
          expect(entry.width).toBe(23 * (spriteScale ? 2 : 1));
          expect(entry.height).toBe(23 * (spriteScale ? 2 : 1));
          expect(entry.x + entry.width).toBeLessThanOrEqual(width);
          expect(entry.y + entry.height).toBeLessThanOrEqual(height);
        }
      }
    });
  }
});

describe("bundled basemap highway shields", () => {
  const shieldCases = [
    ["highway-shield-motorway", "motorway", "motorway"],
    ["highway-shield-bundesstrasse", "road_yellow", "road_yellow"],
    ["highway-shield-landstrasse", "road_yellow", "road_yellow"],
    ["highway-shield-kreisstrasse", "road_yellow", "road_yellow"],
    ["highway-shield-us-interstate", "us-interstate", "us-interstate"],
    ["highway-shield-us-other", "us-highway", "us-highway"],
    ["highway-shield-us-other", "us-state", "us-state"],
  ] as const;

  for (const spriteScale of ["", "@2x"]) {
    it(`resolves every highway shield through both styles and ${spriteScale || "1x"} sprites`, () => {
      const manifest = readSprite(`sprite${spriteScale}.json`);
      const png = readFileSync(resolve(publicStyles, `sprite${spriteScale}.png`));
      const atlasWidth = png.readUInt32BE(16);
      const atlasHeight = png.readUInt32BE(20);
      const pixelRatio = spriteScale ? 2 : 1;

      for (const styleName of ["openmapx-streets.json", "openmapx-dark.json"]) {
        const style = readStyle(styleName);
        for (const [layerId, network, family] of shieldCases) {
          const layer = style.layers.find((candidate) => candidate.id === layerId);
          if (!layer) throw new Error(`${layerId} missing from ${styleName}`);
          const template = layer.layout?.["icon-image"];
          if (typeof template !== "string") throw new Error(`${layerId} has no icon template`);

          for (let refLength = 1; refLength <= 6; refLength++) {
            const icon = template
              .replaceAll("{network}", network)
              .replaceAll("{ref_length}", String(refLength));
            expect(icon).toBe(`${family}_${refLength}`);
            const entry = manifest[icon];
            if (!entry) throw new Error(`${icon} missing from ${spriteScale || "1x"} sprite`);
            expect(entry.pixelRatio).toBe(pixelRatio);
            expect(entry.width).toBeGreaterThan(0);
            expect(entry.height).toBeGreaterThan(0);
            expect(entry.x + entry.width).toBeLessThanOrEqual(atlasWidth);
            expect(entry.y + entry.height).toBeLessThanOrEqual(atlasHeight);
          }
        }
      }
    });
  }
});
