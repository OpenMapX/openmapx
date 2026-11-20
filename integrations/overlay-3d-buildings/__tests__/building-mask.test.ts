import { classifyRings, VectorTile } from "@mapbox/vector-tile";
import { fromVectorTileJs, GeoJSONWrapper } from "@maplibre/vt-pbf";
import type { BuildingReplacement } from "@openmapx/core";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import {
  replacementsForTile,
  rewriteBuildingTile,
  type TileCoordinate,
  tileBounds,
} from "../building-mask";

const EXTENT = 4096;
const TILE: TileCoordinate = { z: 14, x: 8192, y: 5461 };
const [WEST, SOUTH, EAST, NORTH] = tileBounds(TILE);

/** Tile pixel → lng/lat inside TILE (linear in x; latitude via inverse Mercator). */
function lngLat(px: number, py: number): [number, number] {
  const n = 2 ** TILE.z;
  const lng = ((TILE.x + px / EXTENT) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (TILE.y + py / EXTENT)) / n);
  return [lng, (Math.atan(Math.sinh(merc)) * 180) / Math.PI];
}

type Ring = [number, number][];
const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

function tile(features: { id: number; rings: Ring[]; height?: number }[], layer = "building") {
  const wrapper = new GeoJSONWrapper(
    features.map((f) => ({
      id: f.id,
      type: 3 as const,
      tags: { render_height: f.height ?? 10 },
      geometry: f.rings,
    })),
    { version: 2, extent: EXTENT },
  );
  wrapper.name = layer;
  return fromVectorTileJs({ layers: { [layer]: wrapper } });
}

function decode(bytes: Uint8Array, layer = "building") {
  const source = new VectorTile(new PbfReader(bytes)).layers[layer];
  const features: { id: number | undefined; area: number; height: unknown; holes: number }[] = [];
  for (let i = 0; i < (source?.length ?? 0); i++) {
    const feature = source?.feature(i);
    if (!feature) continue;
    for (const polygon of classifyRings(feature.loadGeometry())) {
      const ringArea = (ring: { x: number; y: number }[]) =>
        Math.abs(
          ring.reduce((sum, p, j) => {
            const q = ring[(j + 1) % ring.length] as { x: number; y: number };
            return sum + p.x * q.y - q.x * p.y;
          }, 0) / 2,
        );
      const [outer, ...holes] = polygon;
      features.push({
        id: feature.id,
        area: ringArea(outer ?? []) - holes.reduce((s, h) => s + ringArea(h), 0),
        height: feature.properties.render_height,
        holes: holes.length,
      });
    }
  }
  return features;
}

function footprintReplacement(
  ring: Ring,
  featureIds: number[] = [],
  bbox?: [number, number, number, number],
): BuildingReplacement {
  const coords = ring.map(([x, y]) => lngLat(x, y));
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return {
    id: `r${Math.random()}`,
    featureIds,
    footprint: { type: "MultiPolygon", coordinates: [[coords]] },
    bbox: bbox ?? [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
  };
}

describe("rewriteBuildingTile", () => {
  it("returns the original bytes when no replacement touches the tile", () => {
    const bytes = tile([{ id: 12, rings: [square(100, 100, 200, 200)] }]);
    expect(rewriteBuildingTile(bytes, TILE, "building", [])).toBe(bytes);
    const elsewhere: BuildingReplacement = {
      id: "far",
      featureIds: [12],
      bbox: [WEST - 1, SOUTH - 1, WEST - 0.5, SOUTH - 0.5],
    };
    expect(replacementsForTile(TILE, [elsewhere])).toEqual([]);
  });

  it("drops a feature by exact id inside the replacement bbox", () => {
    const bytes = tile([
      { id: 4875197902, rings: [square(100, 100, 200, 200)] },
      { id: 22, rings: [square(1000, 1000, 1100, 1100)] },
    ]);
    const [w, n] = lngLat(90, 90);
    const [e, s] = lngLat(210, 210);
    const replacement: BuildingReplacement = {
      id: "r",
      featureIds: [4875197902],
      bbox: [w, s, e, n],
    };
    const out = decode(rewriteBuildingTile(bytes, TILE, "building", [replacement]));
    expect(out.map((f) => f.id)).toEqual([22]);
  });

  it("keeps a same-id feature far outside the replacement bbox", () => {
    const bytes = tile([{ id: 4875197902, rings: [square(3000, 3000, 3100, 3100)] }]);
    const [w, n] = lngLat(90, 90);
    const [e, s] = lngLat(210, 210);
    const replacement: BuildingReplacement = {
      id: "r",
      featureIds: [4875197902],
      bbox: [w, s, e, n],
    };
    expect(decode(rewriteBuildingTile(bytes, TILE, "building", [replacement]))).toHaveLength(1);
  });

  it("drops a merged component covered at least 80%", () => {
    const bytes = tile([
      { id: 40, rings: [square(100, 100, 200, 200)] },
      { id: 50, rings: [square(1000, 1000, 1100, 1100)] },
    ]);
    // Covers 90% of the first square.
    const out = decode(
      rewriteBuildingTile(bytes, TILE, "building", [
        footprintReplacement(square(110, 100, 200, 200)),
      ]),
    );
    expect(out.map((f) => f.id)).toEqual([50]);
  });

  it("subtracts a footprint covering less than 80%", () => {
    const bytes = tile([{ id: 40, rings: [square(100, 100, 300, 200)] }]);
    // Covers the left half.
    const out = decode(
      rewriteBuildingTile(bytes, TILE, "building", [
        footprintReplacement(square(100, 100, 200, 200)),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.area).toBeGreaterThan(9_000);
    expect(out[0]?.area).toBeLessThan(11_000);
  });

  it("keeps holes and properties of untouched features", () => {
    const bytes = tile([
      {
        id: 60,
        rings: [square(500, 500, 900, 900), square(600, 600, 700, 700).reverse()],
        height: 33,
      },
    ]);
    const out = decode(
      rewriteBuildingTile(bytes, TILE, "building", [
        footprintReplacement(square(100, 100, 200, 200)),
      ]),
    );
    expect(out).toEqual([{ id: 60, area: 150_000, height: 33, holes: 1 }]);
  });

  it("rewrites only the named source layer", () => {
    const bytes = tile([{ id: 70, rings: [square(100, 100, 300, 200)] }], "buildings");
    const out = rewriteBuildingTile(bytes, TILE, "buildings", [
      footprintReplacement(square(100, 100, 200, 200)),
    ]);
    expect(decode(out, "buildings")).toHaveLength(1);
    expect(Object.keys(new VectorTile(new PbfReader(out)).layers)).toEqual(["buildings"]);
  });
});
