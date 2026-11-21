import { assert, describe, expect, it } from "vitest";
import {
  antisolarPoint,
  darkRegion,
  solarAltitudeDeg,
  solarAzimuthDeg,
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
});

describe("antisolarPoint", () => {
  it("is the antipode of the subsolar point, wrapped into [-180, 180)", () => {
    for (const date of [JUN_SOLSTICE, DEC_SOLSTICE, MAR_EQUINOX]) {
      const { lat, lng } = antisolarPoint(date);
      expect(solarAltitudeDeg(date, lat, lng)).toBeCloseTo(-90, 2);
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThan(180);
    }
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

/** The minute of the UTC day with the highest sun at a place. */
function solarNoon(day: Date, lat: number, lng: number): Date {
  let best = day;
  let bestAltitude = -Infinity;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const date = new Date(day.getTime() + minute * 60_000);
    const altitude = solarAltitudeDeg(date, lat, lng);
    if (altitude > bestAltitude) {
      best = date;
      bestAltitude = altitude;
    }
  }
  return best;
}

describe("solarAzimuthDeg", () => {
  const berlin = { lat: 52.52, lng: 13.405 };

  it("points due south at local solar noon in the northern mid-latitudes", () => {
    const noon = solarNoon(new Date("2026-03-20T00:00:00Z"), 50, 8);
    expect(solarAzimuthDeg(noon, 50, 8)).toBeCloseTo(180, 0);
  });

  it("points due north at local solar noon in the southern mid-latitudes", () => {
    const noon = solarNoon(new Date("2026-06-21T00:00:00Z"), -34, 151);
    const azimuth = solarAzimuthDeg(noon, -34, 151);
    expect(Math.min(azimuth, 360 - azimuth)).toBeLessThan(0.5);
  });

  it("rises in the east and sets in the west", () => {
    const morning = solarAzimuthDeg(new Date("2026-06-21T06:00:00Z"), berlin.lat, berlin.lng);
    const evening = solarAzimuthDeg(new Date("2026-06-21T18:00:00Z"), berlin.lat, berlin.lng);
    expect(morning).toBeGreaterThan(0);
    expect(morning).toBeLessThan(180);
    expect(evening).toBeGreaterThan(180);
    expect(evening).toBeLessThan(360);
  });

  it("matches the NOAA solar calculator for Berlin at the June solstice", () => {
    // Reference values from the NOAA spreadsheet formulation, computed independently.
    expect(solarAzimuthDeg(new Date("2026-06-21T06:00:00Z"), berlin.lat, berlin.lng)).toBeCloseTo(
      84.97,
      0,
    );
    expect(solarAzimuthDeg(new Date("2026-06-21T18:00:00Z"), berlin.lat, berlin.lng)).toBeCloseTo(
      294.37,
      0,
    );
  });

  it("stays finite and in range at the poles", () => {
    for (const lat of [90, -90]) {
      const azimuth = solarAzimuthDeg(JUN_SOLSTICE, lat, 0);
      expect(Number.isFinite(azimuth)).toBe(true);
      expect(azimuth).toBeGreaterThanOrEqual(0);
      expect(azimuth).toBeLessThan(360);
    }
  });
});

/** A polygon's outer ring, failing the test when the polygon has none. */
function outerRing(geometry: { coordinates: GeoJSON.Position[][] }): [number, number][] {
  const [ring] = geometry.coordinates;
  assert.isDefined(ring);
  return ring as [number, number][];
}

function pointInRing(ring: [number, number][], lng: number, lat: number): boolean {
  let inside = false;
  let previous = ring.at(-1);
  for (const current of ring) {
    const [xi, yi] = current;
    const [xj, yj] = previous ?? current;
    previous = current;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const BAND_ALTITUDES = [0, -6, -12, -18];
const DATES: readonly [Date, Date, Date, Date] = [
  new Date("2026-03-20T12:00:00Z"),
  new Date("2026-06-21T12:00:00Z"),
  new Date("2026-09-22T18:00:00Z"),
  new Date("2026-12-21T03:00:00Z"),
];

describe("darkRegion", () => {
  it("puts every non-clamped vertex at exactly the target altitude", () => {
    for (const date of DATES) {
      for (const altitudeDeg of BAND_ALTITUDES) {
        const ring = outerRing(darkRegion(date, altitudeDeg).geometry);
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
        const ring = outerRing(darkRegion(date, altitudeDeg).geometry);
        const sub = subsolarPoint(date);
        const anti = antisolarPoint(date);
        expect(pointInRing(ring, anti.lng, anti.lat)).toBe(true);
        expect(pointInRing(ring, sub.lng, sub.lat)).toBe(false);
      }
    }
  });

  it("returns a closed ring with in-range latitudes", () => {
    const ring = outerRing(darkRegion(DATES[1], -12).geometry);
    expect(ring.length).toBeGreaterThan(3);
    expect(ring[0]).toEqual(ring.at(-1));
    for (const [, lat] of ring) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90.000001);
    }
  });

  it("throws for a positive altitude threshold", () => {
    expect(() => darkRegion(DATES[0], 10)).toThrow(RangeError);
  });

  it("throws when stepDeg does not evenly divide 360", () => {
    expect(() => darkRegion(DATES[0], -18, 7)).toThrow(RangeError);
  });

  it("throws for a non-positive stepDeg", () => {
    // 360 % -1 === 0, so the divisibility check alone would accept this and
    // poleBranchRing's `for (let lng = -180; lng <= 180; lng += stepDeg)` would
    // never terminate.
    expect(() => darkRegion(DATES[0], -18, -1)).toThrow(RangeError);
    expect(() => darkRegion(DATES[0], -18, 0)).toThrow(RangeError);
  });
});

describe("twilightBands", () => {
  it("emits sequentially indexed bands from the horizon down to full night", () => {
    const fc = twilightBands(DATES[1]);
    expect(fc.features).toHaveLength(16);
    expect(fc.features[0]?.properties).toMatchObject({ band: 0, altitudeDeg: 0 });
    expect(fc.features[15]?.properties.band).toBe(15);
    expect(fc.features[15]?.properties.altitudeDeg).toBeCloseTo(-16.875, 3);
  });

  it("contains the antisolar point in every band", () => {
    for (const date of DATES) {
      const fc = twilightBands(date);
      const anti = antisolarPoint(date);
      for (const feature of fc.features) {
        const ring = outerRing(feature.geometry);
        expect(pointInRing(ring, anti.lng, anti.lat)).toBe(true);
      }
    }
  });

  it("nests each band inside the one before it", () => {
    for (const date of DATES) {
      const fc = twilightBands(date);
      for (const [i, feature] of fc.features.entries()) {
        const previous = fc.features[i - 1];
        if (!previous) continue;
        const inner = outerRing(feature.geometry);
        const outer = outerRing(previous.geometry);
        for (const [lng, lat] of inner) {
          if (Math.abs(lat) >= 89.99) continue;
          // capBranchRing leaves longitudes unwrapped across the antimeridian,
          // so the same physical point can differ between rings by +-360.
          const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
          const contained =
            pointInRing(outer, wrapped, lat) ||
            pointInRing(outer, wrapped - 360, lat) ||
            pointInRing(outer, wrapped + 360, lat);
          expect(contained).toBe(true);
        }
      }
    }
  });

  it("throws when stepDeg does not evenly divide 360", () => {
    expect(() => twilightBands(DATES[0], { stepDeg: 7 })).toThrow(RangeError);
  });

  it("throws for a non-positive stepDeg", () => {
    expect(() => twilightBands(DATES[0], { stepDeg: -1 })).toThrow(RangeError);
  });
});
