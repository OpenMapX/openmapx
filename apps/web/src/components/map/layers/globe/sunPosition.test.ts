import { describe, expect, it } from "vitest";
import { greenwichSiderealAngle, subsolarPoint, sunDirection } from "./sunPosition";

const RADIANS = Math.PI / 180;

describe("subsolarPoint", () => {
  it("puts the subsolar point on the equator at the March equinox", () => {
    expect(subsolarPoint(new Date("2026-03-20T14:46:00Z")).lat).toBeCloseTo(0, 1);
  });

  it("reaches the tropics at the solstices", () => {
    expect(subsolarPoint(new Date("2026-06-21T08:24:00Z")).lat).toBeCloseTo(23.44, 1);
    expect(subsolarPoint(new Date("2026-12-21T20:50:00Z")).lat).toBeCloseTo(-23.44, 1);
  });

  it("follows the equation of time at noon UTC", () => {
    // Early November the Sun runs about 16.4 minutes fast, so it has already
    // crossed Greenwich at 12:00 UTC; mid-February it runs about 14.2 minutes slow.
    expect(subsolarPoint(new Date("2026-11-03T12:00:00Z")).lng).toBeCloseTo(-4.1, 0);
    expect(subsolarPoint(new Date("2026-02-11T12:00:00Z")).lng).toBeCloseTo(3.55, 0);
  });

  it("keeps the longitude in [-180, 180) across the antimeridian", () => {
    const { lng } = subsolarPoint(new Date("2026-11-03T00:00:00Z"));
    expect(lng).toBeGreaterThanOrEqual(-180);
    expect(lng).toBeLessThan(180);
    expect(Math.abs(lng)).toBeGreaterThan(170);
  });
});

describe("sunDirection", () => {
  it("returns the subsolar point as a unit vector in MapLibre's globe frame", () => {
    const date = new Date("2026-06-21T12:00:00Z");
    const { lng, lat } = subsolarPoint(date);
    const expected = [
      Math.sin(lng * RADIANS) * Math.cos(lat * RADIANS),
      Math.sin(lat * RADIANS),
      Math.cos(lng * RADIANS) * Math.cos(lat * RADIANS),
    ];
    const vector = sunDirection(date);
    for (let i = 0; i < 3; i++) expect(vector[i]).toBeCloseTo(expected[i], 5);
    expect(Math.hypot(vector[0], vector[1], vector[2])).toBeCloseTo(1, 6);
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
