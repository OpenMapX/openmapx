import type { LngLat } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import { describe, expect, it } from "vitest";

import {
  buildNavRouteLine,
  type NavRouteLine,
  navRouteProgressFraction,
  splitNavRoute,
} from "./navRouteSplit";

const ROUTE: LngLat[] = [
  [6.95, 50.94],
  [6.96, 50.95],
  [6.97, 50.95],
];

const lengthKm = length(lineString(ROUTE), { units: "kilometers" });

// Inverse of the `projectX`/`projectY` Web-Mercator formulas navRouteSplit.ts
// duplicates from `@maplibre/geojson-vt`'s `convert.ts`. Kept independent of
// that module (not imported) so the equivalence test below actually checks
// something, rather than trivially agreeing with itself.
function unprojectX(x: number): number {
  return (x - 0.5) * 360;
}
function unprojectY(y: number): number {
  const s = Math.tanh(Math.PI * (1 - 2 * y));
  return (Math.asin(s) * 180) / Math.PI;
}
function projectX(lng: number): number {
  return lng / 360 + 0.5;
}
function projectY(lat: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * Reconstruct the geographic point a `line-progress` fraction refers to,
 * using only the prepared route's cumulative Mercator table — the same table
 * `navRouteProgressFraction` produces from, walked in reverse. This is how a
 * `line-gradient` color stop at that fraction would map back to a location on
 * the map, so it is the right independent check for "does the fraction mean
 * what we think it means".
 */
function reconstructPositionFromFraction(
  prepared: NavRouteLine,
  fraction: number,
): [number, number] {
  const target = fraction * prepared.mercatorTotal;
  const coords = prepared.line.geometry.coordinates;
  const { mercatorCumulative } = prepared;
  let segIdx = mercatorCumulative.length - 2;
  for (let i = 0; i < mercatorCumulative.length - 1; i++) {
    if (target <= mercatorCumulative[i + 1]) {
      segIdx = i;
      break;
    }
  }
  const segStart = coords[segIdx];
  const segEnd = coords[segIdx + 1];
  const segMercLen = mercatorCumulative[segIdx + 1] - mercatorCumulative[segIdx];
  const ratio = segMercLen > 1e-12 ? (target - mercatorCumulative[segIdx]) / segMercLen : 0;
  const mx = projectX(segStart[0]) + ratio * (projectX(segEnd[0]) - projectX(segStart[0]));
  const my = projectY(segStart[1]) + ratio * (projectY(segEnd[1]) - projectY(segStart[1]));
  return [unprojectX(mx), unprojectY(my)];
}

function metersBetween(a: [number, number], b: [number, number]): number {
  return length(lineString([a, b]), { units: "kilometers" }) * 1000;
}

// Denser than ROUTE so segment lengths stay short (sub-km), which is what
// keeps the geodesic-vs-Mercator interpolation error below the sub-metre
// tolerance the equivalence test asserts on.
const DENSE_ROUTE: LngLat[] = [
  [6.9, 50.9],
  [6.92, 50.91],
  [6.95, 50.94],
  [6.96, 50.95],
  [6.97, 50.95],
  [6.99, 50.97],
];

describe("splitNavRoute", () => {
  it("returns only the remaining segment when no distance has been traveled", () => {
    const features = splitNavRoute(ROUTE, 0);
    expect(features.length).toBe(1);
    expect(features[0].properties).toEqual({ kind: "remaining" });
  });

  it("splits into traveled + remaining mid-route", () => {
    const features = splitNavRoute(ROUTE, (lengthKm / 2) * 1000);
    expect(features.map((f) => f.properties?.kind)).toEqual(["traveled", "remaining"]);
  });

  it("does not throw when alongMeters exceeds the geometry length (stale reroute progress)", () => {
    // After a reroute the new, shorter route is applied while `progress` still
    // holds the previous route's far-larger alongMeters for one render. The
    // clamp must keep the slice start within the line instead of throwing
    // "Start position is beyond line".
    expect(() => splitNavRoute(ROUTE, 9_000_000)).not.toThrow();
    const kinds = splitNavRoute(ROUTE, 9_000_000).map((f) => f.properties?.kind);
    expect(kinds).toContain("traveled");
  });

  it("is safe at exactly the geometry length", () => {
    expect(() => splitNavRoute(ROUTE, lengthKm * 1000)).not.toThrow();
  });

  it("returns nothing for a degenerate geometry", () => {
    expect(splitNavRoute([[0, 0]], 0)).toEqual([]);
  });
});

describe("navRouteProgressFraction", () => {
  it("matches splitNavRoute's traveled/remaining cut point (sub-metre) across progress values", () => {
    const prepared = buildNavRouteLine(DENSE_ROUTE);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    for (const ratio of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const alongMeters = totalMeters * ratio;
      const features = splitNavRoute(DENSE_ROUTE, alongMeters, prepared);
      const traveled = features.find((f) => f.properties?.kind === "traveled") as
        | GeoJSON.Feature<GeoJSON.LineString>
        | undefined;
      expect(traveled).toBeDefined();
      const coords = traveled?.geometry.coordinates ?? [];
      const cutPoint = coords[coords.length - 1] as [number, number];

      const fraction = navRouteProgressFraction(prepared, alongMeters);
      const reconstructed = reconstructPositionFromFraction(prepared, fraction);

      expect(metersBetween(cutPoint, reconstructed)).toBeLessThan(1);
    }
  });

  it("diverges from the naive geodesic fraction on a route spanning latitude", () => {
    // This is the guard against a future "simplification" back to
    // `alongMeters / totalMeters`: the Mercator scale factor is
    // `1 / cos(latitude)`, so the same geodesic distance covers less
    // Mercator-planar distance near latitude 60 than near latitude 40. The
    // true `line-progress` midpoint is therefore measurably off the geodesic
    // midpoint on a route spanning that range.
    const route: LngLat[] = [
      [0, 40],
      [0, 60],
    ];
    const prepared = buildNavRouteLine(route);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    const fraction = navRouteProgressFraction(prepared, totalMeters / 2);

    expect(Math.abs(fraction - 0.5)).toBeGreaterThan(0.01);
  });

  it("handles a high-latitude route (~78°) without throwing and stays within [0, 1]", () => {
    const route: LngLat[] = [
      [10, 77],
      [10.5, 78],
      [11, 78.5],
    ];
    const prepared = buildNavRouteLine(route);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    for (const ratio of [0, 0.3, 0.6, 1]) {
      const fraction = navRouteProgressFraction(prepared, totalMeters * ratio);
      expect(Number.isFinite(fraction)).toBe(true);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it("handles a route crossing the equator without throwing", () => {
    const route: LngLat[] = [
      [5, -10],
      [5, 0],
      [5, 10],
    ];
    const prepared = buildNavRouteLine(route);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    const fraction = navRouteProgressFraction(prepared, totalMeters / 2);
    expect(Number.isFinite(fraction)).toBe(true);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  it("is monotonically non-decreasing as alongMeters increases", () => {
    const prepared = buildNavRouteLine(DENSE_ROUTE);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    let previous = -1;
    for (let i = 0; i <= 50; i++) {
      const fraction = navRouteProgressFraction(prepared, (totalMeters * i) / 50);
      expect(fraction).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    }
  });

  it("returns exact boundaries, clamps out-of-range input, and never returns NaN", () => {
    const prepared = buildNavRouteLine(DENSE_ROUTE);
    if (!prepared) throw new Error("expected a prepared line");
    const totalMeters = prepared.lengthKm * 1000;

    expect(navRouteProgressFraction(prepared, 0)).toBe(0);
    expect(navRouteProgressFraction(prepared, totalMeters)).toBe(1);
    expect(navRouteProgressFraction(prepared, totalMeters * 10)).toBe(1);
    expect(navRouteProgressFraction(prepared, -100)).toBe(0);
    expect(navRouteProgressFraction(prepared, Number.NaN)).toBe(0);
    expect(navRouteProgressFraction(prepared, Number.POSITIVE_INFINITY)).toBe(1);
    expect(navRouteProgressFraction(prepared, Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("handles degenerate geometry without throwing: a 2-point route", () => {
    const prepared = buildNavRouteLine([
      [6.9, 50.9],
      [6.91, 50.91],
    ]);
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    expect(() => navRouteProgressFraction(prepared, prepared.lengthKm * 500)).not.toThrow();
    expect(Number.isFinite(navRouteProgressFraction(prepared, prepared.lengthKm * 500))).toBe(true);
  });

  it("handles degenerate geometry without throwing: duplicate consecutive points", () => {
    const prepared = buildNavRouteLine([
      [6.9, 50.9],
      [6.9, 50.9],
      [6.95, 50.94],
    ]);
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    expect(() => navRouteProgressFraction(prepared, 100)).not.toThrow();
    expect(Number.isFinite(navRouteProgressFraction(prepared, 100))).toBe(true);
  });

  it("handles degenerate geometry without throwing: a NaN coordinate from a bad polyline decode", () => {
    const prepared = buildNavRouteLine([
      [6.9, 50.9],
      [Number.NaN, 50.95],
      [6.97, 50.95],
    ]);
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    expect(() => navRouteProgressFraction(prepared, 500)).not.toThrow();
    expect(navRouteProgressFraction(prepared, 500)).toBe(0);
  });
});
