import { describe, expect, it } from "vitest";
import {
  bufferPolyline,
  clipRingsToSquare,
  convexHull,
  dashes,
  distanceToPolyline,
  minAreaRect,
  offsetPolyline,
  type Pt,
  pointInPolygon,
  polylineLength,
  type Ring,
  ringArea,
  slice,
  transformTemplate,
} from "../web/derive/geometry";

const totalArea = (rings: Ring[]) => rings.reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);

function expectPoint(actual: Pt | undefined, expected: Pt, digits = 9) {
  expect(actual?.[0]).toBeCloseTo(expected[0], digits);
  expect(actual?.[1]).toBeCloseTo(expected[1], digits);
}

describe("geometry", () => {
  it("measures ring area with the shoelace formula", () => {
    expect(
      ringArea([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
    ).toBe(12);
  });

  it("buffers a straight line into a flat-capped strip", () => {
    const rings = bufferPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      3,
    );
    expect(Math.abs(totalArea(rings) - 60)).toBeLessThan(0.01);
  });

  it("fills the outer side of a bend with a fan", () => {
    const rings = bufferPolyline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      1,
    );
    // Two 10 × 2 quads plus a quarter disc of radius 1 at the corner.
    expect(Math.abs(totalArea(rings) - (40 + Math.PI / 4))).toBeLessThan(0.05);
  });

  it("offsets to the right of travel and keeps a right angle at the mitre point", () => {
    const line = offsetPolyline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      1,
    );
    expect(line).toHaveLength(3);
    expectPoint(line[0], [0, 1]);
    expectPoint(line[1], [9, 1]);
    expectPoint(line[2], [9, 10]);
  });

  it("limits the mitre to twice the offset on sharp turns", () => {
    const line = offsetPolyline(
      [
        [0, 0],
        [10, 0],
        [0, 0.5],
      ],
      1,
    );
    const corner = line[1] as Pt;
    expect(Math.hypot(corner[0] - 10, corner[1])).toBeLessThanOrEqual(2 + 1e-9);
  });

  it("measures, slices and dashes polylines", () => {
    const line: Pt[] = [
      [0, 0],
      [60, 0],
      [60, 40],
    ];
    expect(polylineLength(line)).toBe(100);
    expect(slice(line, 50, 70)).toEqual([
      [50, 0],
      [60, 0],
      [60, 10],
    ]);
    const pieces = dashes(line, 3, 6);
    expect(pieces).toHaveLength(12);
    expect(polylineLength(pieces[0] as Pt[])).toBeCloseTo(3, 9);
    expect(polylineLength(pieces[11] as Pt[])).toBeCloseTo(1, 9);
  });

  it("clips rings to a square", () => {
    const rings = clipRingsToSquare(
      [
        [
          [-5, 0],
          [5, 0],
          [5, 10],
          [-5, 10],
        ],
        [
          [20, 20],
          [30, 20],
          [30, 30],
        ],
      ],
      0,
      10,
    );
    expect(rings).toHaveLength(1);
    expect(Math.abs(ringArea(rings[0] as Ring))).toBeCloseTo(50, 9);
  });

  it("tests points against polygons with holes", () => {
    const outer: Ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: Ring = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ];
    expect(pointInPolygon([2, 2], outer, [hole])).toBe(true);
    expect(pointInPolygon([5, 5], outer, [hole])).toBe(false);
    expect(pointInPolygon([12, 5], outer, [hole])).toBe(false);
  });

  it("finds the nearest point on a polyline", () => {
    const result = distanceToPolyline(
      [5, 3],
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    );
    expect(result).toEqual({ d: 3, segment: 0, t: 0.5 });
  });

  it("fits the minimum-area rectangle of a rotated pitch within a centimetre", () => {
    const angle = 0.37;
    const axis: Pt = [Math.cos(angle), Math.sin(angle)];
    const across: Pt = [-axis[1], axis[0]];
    const corner = (u: number, v: number): Pt => [
      100 + axis[0] * u + across[0] * v,
      50 + axis[1] * u + across[1] * v,
    ];
    const points = [
      corner(-52.5, -34),
      corner(52.5, -34),
      corner(52.5, 34),
      corner(-52.5, 34),
      corner(0, 0),
      corner(10, 5),
    ];
    const rect = minAreaRect(convexHull(points));
    expect(Math.abs(rect.length - 105)).toBeLessThan(0.01);
    expect(Math.abs(rect.width - 68)).toBeLessThan(0.01);
    expect(Math.abs(rect.centre[0] - 100)).toBeLessThan(0.01);
    expect(Math.abs(rect.centre[1] - 50)).toBeLessThan(0.01);
    expect(Math.abs(Math.abs(rect.axis[0] * axis[0] + rect.axis[1] * axis[1]) - 1)).toBeLessThan(
      1e-6,
    );
  });

  it("places a template along an axis", () => {
    const [ring] = transformTemplate(
      [
        [
          [0, 0],
          [0, 10],
        ],
      ],
      [100, 200],
      [1, 0],
      2,
    );
    expectPoint(ring?.[0], [100, 200]);
    expectPoint(ring?.[1], [120, 200]);
  });
});
