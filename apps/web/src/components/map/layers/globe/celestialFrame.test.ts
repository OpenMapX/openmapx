import { describe, expect, it } from "vitest";
import { nth } from "@/test";
import { galacticRotation } from "./celestialFrame";
import { greenwichSiderealAngle } from "./sunPosition";

const RADIANS = Math.PI / 180;

type Vec3 = [number, number, number];

/** The globe-frame direction of a star with the given right ascension and declination. */
function starDirection(rightAscension: number, declination: number, date: Date): Vec3 {
  const longitude = rightAscension * RADIANS - greenwichSiderealAngle(date);
  const latitude = declination * RADIANS;
  return [
    Math.sin(longitude) * Math.cos(latitude),
    Math.sin(latitude),
    Math.cos(longitude) * Math.cos(latitude),
  ];
}

/** Column-major 3×3 matrix times vector. */
function apply(matrix: ArrayLike<number>, [x, y, z]: Vec3): number[] {
  const m = (i: number) => nth(matrix, i);
  return [0, 1, 2].map((row) => m(row) * x + m(row + 3) * y + m(row + 6) * z);
}

const DATES = [new Date("2026-11-21T12:00:00Z"), new Date("2031-04-02T03:17:00Z")] as const;

describe("galacticRotation", () => {
  it.each(DATES)("is orthonormal at %s", (date) => {
    const m = galacticRotation(date);
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const dot =
          nth(m, a * 3) * nth(m, b * 3) +
          nth(m, a * 3 + 1) * nth(m, b * 3 + 1) +
          nth(m, a * 3 + 2) * nth(m, b * 3 + 2);
        expect(dot).toBeCloseTo(a === b ? 1 : 0, 6);
      }
    }
  });

  it.each(DATES)("points the Galactic Centre along galactic +x at %s", (date) => {
    const [x, y, z] = apply(galacticRotation(date), starDirection(266.405, -28.936, date));
    expect(x).toBeCloseTo(1, 3);
    expect(y).toBeCloseTo(0, 3);
    expect(z).toBeCloseTo(0, 3);
  });

  it.each(DATES)("points the north galactic pole along galactic +z at %s", (date) => {
    const [x, y, z] = apply(galacticRotation(date), starDirection(192.859, 27.128, date));
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(0, 3);
    expect(z).toBeCloseTo(1, 3);
  });

  it.each(DATES)("is a rotation, not a mirror image, at %s", (date) => {
    // Galactic longitude 90°, latitude 0°.
    const [x, y, z] = apply(galacticRotation(date), starDirection(318.004, 48.33, date));
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(1, 3);
    expect(z).toBeCloseTo(0, 3);
  });

  it("writes into a supplied array", () => {
    const out = new Float32Array(9);
    expect(galacticRotation(DATES[0], out)).toBe(out);
  });
});
