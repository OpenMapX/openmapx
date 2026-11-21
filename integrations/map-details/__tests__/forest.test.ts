import { describe, expect, it } from "vitest";
import type { DecodedTile, TileFeature } from "../web/derive/decode";
import {
  FOREST_SPACING_GROUND_M,
  forestSpacing,
  INSTANCE_STRIDE,
  type Instances,
  plantForest,
} from "../web/derive/forest";
import type { Pt } from "../web/derive/geometry";
import { EARTH_CIRCUMFERENCE_M, tileCentreLat } from "../web/derive/units";
import { basemapFixture, GRUNEWALD, GRUNEWALD_SOUTH } from "./fixtures";

const EXTENT = 4096;
/** The z14 tile over Grunewald (52.47°N) and its z16 cells. */
const TILE = { z: 14, x: 8795, y: 5376 };

const square = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const wood = (...rings: Pt[][]): TileFeature => ({
  type: 3,
  geometry: rings,
  props: { class: "wood", subclass: "forest" },
});
function basemap(layers: Partial<Record<string, TileFeature[]>>): DecodedTile {
  return {
    extent: EXTENT,
    layers: {
      landcover: [],
      landuse: [],
      transportation: [],
      building: [],
      water: [],
      ...layers,
    } as Record<string, TileFeature[]>,
  };
}
const FULL_WOOD = basemap({ landcover: [wood(square(-64, -64, EXTENT + 64, EXTENT + 64))] });

interface Tree {
  kind: string;
  x: number;
  y: number;
  heading: number;
  height: number;
  crown: number;
}
function trees(instances: Instances[]): Tree[] {
  return instances.flatMap((set) =>
    Array.from({ length: set.count }, (_, i) => {
      const d = set.data.subarray(i * INSTANCE_STRIDE, (i + 1) * INSTANCE_STRIDE);
      return {
        kind: set.kind,
        x: d[0] as number,
        y: d[1] as number,
        heading: d[2] as number,
        height: d[3] as number,
        crown: d[4] as number,
      };
    }),
  );
}
const cellSize = (cellY: number) =>
  (EARTH_CIRCUMFERENCE_M * Math.cos((tileCentreLat(16, cellY) * Math.PI) / 180)) / 2 ** 16;

describe("forest grid", () => {
  it("spaces trees 11 m / cos(latitude of the z10 tile centre) in Mercator metres", () => {
    const cellY = TILE.y * 4;
    const lat = tileCentreLat(10, Math.floor(cellY / 64));
    expect(forestSpacing(cellY)).toBeCloseTo(
      FOREST_SPACING_GROUND_M / Math.cos((lat * Math.PI) / 180),
      9,
    );
    expect(FOREST_SPACING_GROUND_M).toBe(11);
  });

  it("is deterministic", () => {
    const cell = { x: TILE.x * 4 + 1, y: TILE.y * 4 + 2 };
    expect(plantForest(FULL_WOOD, TILE, cell)).toEqual(plantForest(FULL_WOOD, TILE, cell));
  });

  it("keeps trees inside the cell, without duplicates or a seam between cells", () => {
    const west = { x: TILE.x * 4 + 1, y: TILE.y * 4 + 1 };
    const east = { x: west.x + 1, y: west.y };
    const size = cellSize(west.y);
    const a = trees(plantForest(FULL_WOOD, TILE, west));
    const b = trees(plantForest(FULL_WOOD, TILE, east)).map((t) => ({ ...t, x: t.x + size }));
    for (const t of [...a, ...b.map((t) => ({ ...t, x: t.x - size }))]) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(size);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(size);
    }
    const all = [...a, ...b];
    const keys = new Set(all.map((t) => `${t.x.toFixed(3)},${t.y.toFixed(3)}`));
    expect(keys.size).toBe(all.length);
    // Trees per strip parallel to the shared edge, two grid spacings (about 22 m) wide so
    // strips do not alias with the grid: the strips touching the edge hold as many trees
    // as interior strips.
    const width = 2 * forestSpacing(west.y) * Math.cos((tileCentreLat(16, west.y) * Math.PI) / 180);
    const strip = (from: number) => all.filter((t) => t.x >= from && t.x < from + width).length;
    const interior = [2, 5, 9, 20, 25, 29].map((k) => strip(k * width));
    const mean = interior.reduce((s, n) => s + n, 0) / interior.length;
    for (const edge of [size - width, size])
      expect(Math.abs(strip(edge) - mean) / mean).toBeLessThan(0.15);
  });

  it("keeps clear of roads, buildings, water and settled land, and out of holes", () => {
    const cell = { x: TILE.x * 4, y: TILE.y * 4 };
    const mpu = cellSize(cell.y) / (EXTENT / 4);
    const metresToUnits = (m: number) => m / mpu;
    const hole = square(200, 200, 600, 600);
    const tile = basemap({
      landcover: [wood(square(-64, -64, EXTENT + 64, EXTENT + 64), [...hole].reverse())],
      transportation: [
        {
          type: 2,
          geometry: [
            [
              [0, 800],
              [1024, 800],
            ],
          ],
          props: { class: "primary" },
        },
      ],
      building: [{ type: 3, geometry: [square(700, 100, 760, 160)], props: {} }],
      water: [{ type: 3, geometry: [square(100, 900, 200, 1000)], props: { class: "lake" } }],
      landuse: [
        { type: 3, geometry: [square(800, 400, 1000, 600)], props: { class: "residential" } },
      ],
    });
    const planted = trees(plantForest(tile, TILE, cell));
    expect(planted.length).toBeGreaterThan(500);
    // Back to basemap tile units (y down) for the checks.
    const units = planted.map((t) => [t.x / mpu, EXTENT / 4 - t.y / mpu] as Pt);
    const inside = (p: Pt, r: Pt[], margin: number) =>
      p[0] > (r[0] as Pt)[0] - margin &&
      p[0] < (r[2] as Pt)[0] + margin &&
      p[1] > (r[0] as Pt)[1] - margin &&
      p[1] < (r[2] as Pt)[1] + margin;
    for (const p of units) {
      expect(Math.abs(p[1] - 800)).toBeGreaterThanOrEqual(metresToUnits(12) - 1e-6);
      expect(inside(p, square(700, 100, 760, 160), metresToUnits(3))).toBe(false);
      expect(inside(p, square(100, 900, 200, 1000), metresToUnits(2))).toBe(false);
      expect(inside(p, square(800, 400, 1000, 600), 0)).toBe(false);
      expect(inside(p, hole, 0)).toBe(false);
    }
  });

  it("mixes in conifers by latitude and keeps heights and crowns in range", () => {
    const share = (lat: number) => {
      const y = Math.floor(
        ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** 14,
      );
      const tile = { z: 14, x: 8795, y };
      const planted: Tree[] = [];
      for (let i = 0; i < 4 && planted.length < 10_000; i++)
        for (let j = 0; j < 4 && planted.length < 10_000; j++)
          planted.push(
            ...trees(plantForest(FULL_WOOD, tile, { x: tile.x * 4 + i, y: tile.y * 4 + j })),
          );
      expect(planted.length).toBeGreaterThan(10_000 * 0.9);
      for (const t of planted) {
        expect(t.height).toBeGreaterThanOrEqual(14);
        expect(t.height).toBeLessThanOrEqual(24);
        expect(t.crown / t.height).toBeGreaterThanOrEqual(0.45 - 1e-6);
        expect(t.crown / t.height).toBeLessThanOrEqual(0.6 + 1e-6);
      }
      return planted.filter((t) => t.kind === "conifer").length / planted.length;
    };
    expect(Math.abs(share(50) - 0.3)).toBeLessThan(0.05);
    expect(Math.abs(share(60) - 0.6)).toBeLessThan(0.05);
  });
});

describe("Grunewald fixtures", () => {
  it("plants on both sides of the z14 edge without doubling trees", () => {
    const north = basemapFixture(GRUNEWALD);
    const south = basemapFixture(GRUNEWALD_SOUTH);
    const southTile = { z: 14, x: 8795, y: 5377 };
    const column = TILE.x * 4 + 1;
    const above = { x: column, y: TILE.y * 4 + 3 };
    const below = { x: column, y: southTile.y * 4 };
    const a = trees(plantForest(north, TILE, above));
    const b = trees(plantForest(south, southTile, below));
    expect(a.length).toBeGreaterThan(100);
    expect(b.length).toBeGreaterThan(100);
    const sizeA = cellSize(above.y);
    // In a shared frame (metres north of the lower cell's south edge) no two trees coincide.
    const shared = [...a.map((t) => [t.x, t.y + cellSize(below.y)]), ...b.map((t) => [t.x, t.y])];
    const keys = new Set(shared.map(([x, y]) => `${x?.toFixed(1)},${y?.toFixed(1)}`));
    expect(keys.size).toBe(shared.length);
    expect(sizeA).toBeGreaterThan(0);
  });
});
