import { describe, expect, it } from "vitest";
import {
  darkRegion,
  solarAltitudeDeg,
  solarPosition,
  subsolarPoint,
  twilightBands,
} from "../solar";

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

function pointInRing(ring: [number, number][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const BAND_ALTITUDES = [0, -6, -12, -18];
const DATES = [
  new Date("2026-03-20T12:00:00Z"),
  new Date("2026-06-21T12:00:00Z"),
  new Date("2026-09-22T18:00:00Z"),
  new Date("2026-12-21T03:00:00Z"),
];

describe("darkRegion", () => {
  it("puts every non-clamped vertex at exactly the target altitude", () => {
    for (const date of DATES) {
      for (const altitudeDeg of BAND_ALTITUDES) {
        const ring = darkRegion(date, altitudeDeg).geometry.coordinates[0];
        for (const [lng, lat] of ring) {
          if (Math.abs(lat) >= 89.999) continue;
          expect(solarAltitudeDeg(date, lat, lng)).toBeCloseTo(altitudeDeg, 1);
        }
      }
    }
  });

  it("contains the antisolar point and excludes the subsolar point", () => {
    for (const date of DATES) {
      for (const altitudeDeg of BAND_ALTITUDES) {
        const ring = darkRegion(date, altitudeDeg).geometry.coordinates[0] as [number, number][];
        const sub = subsolarPoint(date);
        const antiLng = sub.lng > 0 ? sub.lng - 180 : sub.lng + 180;
        expect(pointInRing(ring, antiLng, -sub.lat)).toBe(true);
        expect(pointInRing(ring, sub.lng, sub.lat)).toBe(false);
      }
    }
  });

  it("returns a closed ring with in-range latitudes", () => {
    const ring = darkRegion(DATES[1], -12).geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [, lat] of ring) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90.000001);
    }
  });

  it("takes the cap branch when no pole is in the deep-night region", () => {
    expect(darkRegion(new Date("2026-03-20T12:00:00Z"), -18).properties.branch).toBe("cap");
  });

  it("takes the pole branch when a pole is in the deep-night region", () => {
    expect(darkRegion(new Date("2026-06-21T12:00:00Z"), -18).properties.branch).toBe("pole");
  });
});

describe("twilightBands", () => {
  it("emits sequentially indexed bands from the horizon down to full night", () => {
    const fc = twilightBands(DATES[1]);
    expect(fc.features).toHaveLength(16);
    expect(fc.features[0].properties).toMatchObject({ band: 0, altitudeDeg: 0 });
    expect(fc.features[15].properties.band).toBe(15);
    expect(fc.features[15].properties.altitudeDeg).toBeCloseTo(-16.875, 3);
  });

  it("nests each band inside the one before it", () => {
    for (const date of DATES) {
      const fc = twilightBands(date);
      const sub = subsolarPoint(date);
      const antiLng = sub.lng > 0 ? sub.lng - 180 : sub.lng + 180;
      for (const feature of fc.features) {
        const ring = feature.geometry.coordinates[0] as [number, number][];
        expect(pointInRing(ring, antiLng, -sub.lat)).toBe(true);
      }
    }
  });
});
