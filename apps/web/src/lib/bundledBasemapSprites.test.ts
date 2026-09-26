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
        feature: { type: "Point"; properties: { class: string } },
        featureState: undefined,
        canonical: undefined,
        availableImages: string[],
      ) => { name: string; available: boolean } | null;
    };
  };
};

type Layer = { id: string; layout?: { "icon-image"?: unknown } };
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

function resolvedIcon(layer: Layer, poiClass: string, availableImages: string[]): string | null {
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
    { type: "Point", properties: { class: poiClass } },
    undefined,
    undefined,
    availableImages,
  );
  return image?.available ? image.name : null;
}

describe("bundled basemap POI sprites", () => {
  for (const spriteScale of ["", "@2x"]) {
    it(`resolves missing POI classes in both styles with ${spriteScale || "1x"} sprites`, () => {
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
          expect(resolvedIcon(layer, "parking", availableImages)).toBe("car_11");
          expect(resolvedIcon(layer, "atm", availableImages)).toBe("bank_11");
          expect(resolvedIcon(layer, "toilets", availableImages)).toBe("toilet_11");
          expect(resolvedIcon(layer, "office", availableImages)).toBe("marker_11");
          expect(resolvedIcon(layer, "unmapped_class", availableImages)).toBe("marker_11");
          expect(resolvedIcon(layer, "restaurant", availableImages)).toBe("restaurant_11");
        }

        const railway = style.layers.find((candidate) => candidate.id === "poi-railway");
        if (!railway) throw new Error(`poi-railway missing from ${styleName}`);
        expect(resolvedIcon(railway, "railway", availableImages)).toBe("railway_11");
      }
    });
  }
});
