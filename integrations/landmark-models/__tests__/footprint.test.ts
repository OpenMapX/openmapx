import { describe, expect, it } from "vitest";
import { acceptableHull, derivedHull, featureIdsFor, toReplacement } from "../web/footprint";

const ANCHOR: [number, number] = [-73.9796, 40.7592];

/** A 40 m × 20 m box, 100 m tall, in the GLB frame (X east, Y up, Z south). */
function box(): Float32Array {
  const points: number[] = [];
  for (const x of [-20, 20])
    for (const y of [0, 100]) for (const z of [-10, 10]) points.push(x, y, z);
  return new Float32Array(points);
}

function areaM2(ring: number[][]): number {
  const lat0 = ANCHOR[1];
  const xy = ring.map(([lng, lat]) => [
    ((lng as number) - ANCHOR[0]) * 111_320 * Math.cos((lat0 * Math.PI) / 180),
    ((lat as number) - lat0) * 110_574,
  ]);
  let sum = 0;
  for (let i = 0; i < xy.length - 1; i++)
    sum +=
      (xy[i]?.[0] as number) * (xy[i + 1]?.[1] as number) -
      (xy[i + 1]?.[0] as number) * (xy[i]?.[1] as number);
  return Math.abs(sum / 2);
}

describe("derivedHull", () => {
  it("hull of a box model is its base rectangle", () => {
    const hull = derivedHull(box(), ANCHOR);
    expect(hull?.type).toBe("Polygon");
    expect(areaM2(hull?.coordinates[0] as number[][])).toBeGreaterThan(800 * 0.99);
    expect(areaM2(hull?.coordinates[0] as number[][])).toBeLessThan(800 * 1.01);
  });

  it("returns null for fewer than three ground vertices", () => {
    expect(derivedHull(new Float32Array([0, 0, 0, 1, 0, 0, 0, 50, 0]), ANCHOR)).toBeNull();
  });
});

describe("acceptableHull", () => {
  const hull = () => derivedHull(box(), ANCHOR) as NonNullable<ReturnType<typeof derivedHull>>;

  it("accepts a hull within its asset bounds", () => {
    expect(acceptableHull(hull(), [-73.98, 40.7591, -73.9792, 40.7593])).toBe(true);
  });

  it("rejects a hull smaller than 4 m²", () => {
    const tiny = derivedHull(
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      ANCHOR,
    ) as NonNullable<ReturnType<typeof derivedHull>>;
    expect(acceptableHull(tiny, [-73.98, 40.759, -73.979, 40.76])).toBe(false);
  });

  it("rejects a hull larger than 1.5 times the bounds", () => {
    // Bounds of about 20 m × 11 m around the anchor, far smaller than the 800 m² hull.
    expect(acceptableHull(hull(), [-73.97972, 40.75915, -73.97948, 40.75925])).toBe(false);
  });
});

describe("featureIdsFor", () => {
  it("encodes node, way and relation", () => {
    expect(featureIdsFor(["node/5", "way/487519790", "relation/12"])).toEqual([
      51, 4875197902, 123,
    ]);
    expect(featureIdsFor(["bogus", "way/x"])).toEqual([]);
  });
});

describe("toReplacement", () => {
  it("normalizes a polygon footprint to a multipolygon with its bbox", () => {
    const replacement = toReplacement(
      "a",
      {
        type: "Polygon",
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
      ["way/1"],
      [0, 0, 3, 3],
    );
    expect(replacement.footprint?.type).toBe("MultiPolygon");
    expect(replacement.bbox).toEqual([1, 1, 2, 2]);
    expect(replacement.featureIds).toEqual([12]);
  });

  it("uses the asset bounds without a footprint", () => {
    const replacement = toReplacement("b", undefined, ["way/1"], [0, 0, 3, 3]);
    expect(replacement.footprint).toBeUndefined();
    expect(replacement.bbox).toEqual([0, 0, 3, 3]);
  });
});
