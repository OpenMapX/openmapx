import { describe, expect, it } from "vitest";
import {
  bilinear,
  sampleTerrainGrid,
  type TerrainProbe,
  type TerrainSample,
} from "../terrainProbe";

function probe(
  enabled: boolean,
  sample: (lngLat: [number, number]) => TerrainSample,
): TerrainProbe {
  return { enabled: () => enabled, sample };
}

describe("terrainProbe", () => {
  it("returns null without terrain", () => {
    expect(
      sampleTerrainGrid(
        probe(false, () => ({ state: "none" })),
        0,
        0,
        1,
        1,
        3,
      ),
    ).toBeNull();
  });

  it("is pending while any sample is loading or lacks its drawn height", () => {
    let calls = 0;
    const loading = probe(true, () =>
      calls++ === 4 ? { state: "loading" } : { state: "loaded", drawn: 1 },
    );
    expect(sampleTerrainGrid(loading, 0, 0, 1, 1, 3)).toBe("pending");
    const parentOnly = probe(true, () => ({ state: "loaded" }));
    expect(sampleTerrainGrid(parentOnly, 0, 0, 1, 1, 3)).toBe("pending");
  });

  it("samples n × n heights from south-west to north-east, row by row", () => {
    const grid = sampleTerrainGrid(
      probe(true, ([lng, lat]) => ({ state: "loaded", drawn: lng * 10 + lat * 100 })),
      0,
      0,
      2,
      2,
      3,
    );
    expect(grid).toBeInstanceOf(Float32Array);
    expect(Array.from(grid as Float32Array)).toEqual([0, 10, 20, 100, 110, 120, 200, 210, 220]);
  });

  it("interpolates bilinearly and clamps outside the grid", () => {
    const grid = new Float32Array([0, 10, 20, 30]);
    expect(bilinear(grid, 2, 0, 0)).toBe(0);
    expect(bilinear(grid, 2, 1, 0)).toBe(10);
    expect(bilinear(grid, 2, 0, 1)).toBe(20);
    expect(bilinear(grid, 2, 1, 1)).toBe(30);
    expect(bilinear(grid, 2, 0.5, 0.5)).toBe(15);
    expect(bilinear(grid, 2, -1, 2)).toBe(20);
  });
});
