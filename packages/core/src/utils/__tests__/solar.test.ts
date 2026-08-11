import { describe, expect, it } from "vitest";
import { solarAltitudeDeg, solarPosition, subsolarPoint } from "../solar";

const JUN_SOLSTICE = new Date("2026-06-21T12:00:00Z");
const DEC_SOLSTICE = new Date("2026-12-21T12:00:00Z");
const MAR_EQUINOX = new Date("2026-03-20T12:00:00Z");

describe("solarPosition", () => {
  it("puts declination at the northern extreme on the June solstice", () => {
    expect(solarPosition(JUN_SOLSTICE).declinationDeg).toBeCloseTo(23.44, 1);
  });

  it("puts declination at the southern extreme on the December solstice", () => {
    expect(solarPosition(DEC_SOLSTICE).declinationDeg).toBeCloseTo(-23.44, 1);
  });

  it("puts declination near zero at the March equinox", () => {
    expect(Math.abs(solarPosition(MAR_EQUINOX).declinationDeg)).toBeLessThan(0.5);
  });
});

describe("subsolarPoint", () => {
  it("is the point where the sun is directly overhead", () => {
    for (const date of [JUN_SOLSTICE, DEC_SOLSTICE, MAR_EQUINOX]) {
      const { lat, lng } = subsolarPoint(date);
      expect(solarAltitudeDeg(date, lat, lng)).toBeCloseTo(90, 2);
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
    }
  });

  it("puts the antisolar point at an altitude of -90", () => {
    const { lat, lng } = subsolarPoint(JUN_SOLSTICE);
    const antiLng = lng > 0 ? lng - 180 : lng + 180;
    expect(solarAltitudeDeg(JUN_SOLSTICE, -lat, antiLng)).toBeCloseTo(-90, 2);
  });
});

describe("solarAltitudeDeg", () => {
  it("has the sun up at midday and down at midnight in Berlin", () => {
    const berlin = { lat: 52.52, lng: 13.405 };
    const midday = new Date("2026-06-21T11:00:00Z");
    const midnight = new Date("2026-06-21T23:00:00Z");
    expect(solarAltitudeDeg(midday, berlin.lat, berlin.lng)).toBeGreaterThan(50);
    expect(solarAltitudeDeg(midnight, berlin.lat, berlin.lng)).toBeLessThan(0);
  });

  it("keeps the sun up all day above the Arctic Circle at the June solstice", () => {
    for (let hour = 0; hour < 24; hour += 3) {
      const date = new Date(Date.UTC(2026, 5, 21, hour));
      expect(solarAltitudeDeg(date, 78.2, 15.6)).toBeGreaterThan(0);
    }
  });
});
