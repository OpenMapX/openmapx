import { describe, expect, it } from "vitest";
import { countTiles, fillTileTemplate, tilesInBbox } from "./tiles";
import type { OfflineAreaBbox } from "./types";

const BERLIN: OfflineAreaBbox = { west: 13.0, south: 52.4, east: 13.8, north: 52.6 };

describe("tilesInBbox", () => {
  it("returns the single root tile at zoom 0", () => {
    const tiles = tilesInBbox(BERLIN, 0, 0);
    expect(tiles).toEqual([{ z: 0, x: 0, y: 0 }]);
  });

  it("spans every zoom level in the inclusive range", () => {
    const tiles = tilesInBbox(BERLIN, 0, 3);
    const zooms = [...new Set(tiles.map((t) => t.z))].sort((a, b) => a - b);
    expect(zooms).toEqual([0, 1, 2, 3]);
  });

  it("produces exactly the tiles countTiles predicts", () => {
    const minZoom = 8;
    const maxZoom = 11;
    expect(tilesInBbox(BERLIN, minZoom, maxZoom).length).toBe(countTiles(BERLIN, minZoom, maxZoom));
  });

  it("clamps tile coordinates to the valid grid range for the zoom", () => {
    const world: OfflineAreaBbox = { west: -180, south: -85, east: 180, north: 85 };
    const tiles = tilesInBbox(world, 1, 1);
    const inRange = tiles.every((t) => t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1);
    expect(inRange).toBe(true);
    // Whole world at z1 covers the full 2x2 grid.
    expect(tiles.length).toBe(4);
  });
});

describe("countTiles", () => {
  it("counts a single tile at zoom 0", () => {
    expect(countTiles(BERLIN, 0, 0)).toBe(1);
  });

  it("is monotonic as the max zoom increases", () => {
    expect(countTiles(BERLIN, 5, 6) > countTiles(BERLIN, 5, 5)).toBe(true);
  });
});

describe("fillTileTemplate", () => {
  it("substitutes all z/x/y placeholders, including repeats", () => {
    const url = fillTileTemplate("https://t/{z}/{x}/{y}.pbf?v={z}", { z: 12, x: 2200, y: 1346 });
    expect(url).toBe("https://t/12/2200/1346.pbf?v=12");
  });
});
