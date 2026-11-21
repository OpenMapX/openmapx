import { subsolarPoint } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { nth } from "@/test";
import { greenwichSiderealAngle, sunDirection } from "./sunPosition";

const RADIANS = Math.PI / 180;

describe("sunDirection", () => {
  it("follows the seasons", () => {
    expect(sunDirection(new Date("2026-06-21T08:24:00Z"))[1]).toBeCloseTo(
      Math.sin(23.44 * RADIANS),
      3,
    );
    expect(sunDirection(new Date("2026-12-21T20:50:00Z"))[1]).toBeCloseTo(
      -Math.sin(23.44 * RADIANS),
      3,
    );
  });

  it("points at the subsolar point in MapLibre's globe frame", () => {
    const date = new Date("2026-06-21T12:00:00Z");
    const { lng, lat } = subsolarPoint(date);
    const expected = [
      Math.sin(lng * RADIANS) * Math.cos(lat * RADIANS),
      Math.sin(lat * RADIANS),
      Math.cos(lng * RADIANS) * Math.cos(lat * RADIANS),
    ];
    const vector = sunDirection(date);
    for (let i = 0; i < 3; i++) expect(nth(vector, i)).toBeCloseTo(nth(expected, i), 5);
    expect(Math.hypot(nth(vector, 0), nth(vector, 1), nth(vector, 2))).toBeCloseTo(1, 6);
  });

  it("writes into a supplied array", () => {
    const out = new Float32Array(3);
    expect(sunDirection(new Date("2026-01-01T00:00:00Z"), out)).toBe(out);
  });
});

describe("greenwichSiderealAngle", () => {
  it("matches the reference value at J2000", () => {
    expect(greenwichSiderealAngle(new Date("2000-01-01T12:00:00Z"))).toBeCloseTo(
      280.46061837 * RADIANS,
      6,
    );
  });

  it("advances at the sidereal rate", () => {
    expect(greenwichSiderealAngle(new Date("2026-01-01T00:00:00Z"))).toBeCloseTo(
      100.66083 * RADIANS,
      5,
    );
  });

  it("stays in [0, 2π)", () => {
    for (const iso of ["1999-03-01T00:00:00Z", "2026-11-21T18:30:00Z", "2080-07-04T06:00:00Z"]) {
      const angle = greenwichSiderealAngle(new Date(iso));
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(2 * Math.PI);
    }
  });
});
