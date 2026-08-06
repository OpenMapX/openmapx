import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import {
  DEFAULT_CORRIDOR_PAD_METERS,
  PROGRESS_BUCKET_METERS,
  paddedRouteAheadBounds,
  poiAlongRoute,
  progressBucket,
  progressBucketStartMeters,
  routeAheadBounds,
} from "../searchAlongRoute";

// Due-east route; 0.001° ≈ 111 m at the equator.
const geometry: LngLat[] = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
  [0.003, 0],
];

const poi = (id: string, lng: number, lat: number) => ({ id, coordinates: [lng, lat] as LngLat });

describe("poiAlongRoute", () => {
  it("keeps POIs ahead and within the corridor, sorted by along-distance", () => {
    const places = [
      poi("near-far", 0.0025, 0.0001), // ~278 m along, ~11 m off — ahead
      poi("near-close", 0.0015, 0.0001), // ~167 m along, ~11 m off — ahead, nearer
    ];
    const out = poiAlongRoute(places, geometry, 0, { speedMps: 14 });
    expect(out.map((o) => o.place.id)).toEqual(["near-close", "near-far"]);
    expect(out[0].deviationMeters).toBeLessThan(20);
    expect(out[0].detourMeters).toBeCloseTo(2 * out[0].deviationMeters, 5);
  });

  it("drops POIs behind the current position", () => {
    const places = [poi("behind", 0.0005, 0)];
    expect(poiAlongRoute(places, geometry, 200, {})).toEqual([]);
  });

  it("drops POIs outside the corridor", () => {
    const places = [poi("far-off", 0.0015, 0.05)]; // ~5.5 km north of the line
    expect(poiAlongRoute(places, geometry, 0, { corridorMeters: 1200 })).toEqual([]);
  });

  it("respects the look-ahead window", () => {
    const places = [poi("way-ahead", 0.0025, 0)]; // ~278 m along
    expect(poiAlongRoute(places, geometry, 0, { lookaheadMeters: 100 })).toEqual([]);
  });
});

describe("routeAheadBounds", () => {
  it("bounds the vertices within the look-ahead window", () => {
    // From 0 m, look ahead 250 m → includes vertices at 0, ~111, ~222 m (lng 0, 0.001, 0.002).
    const b = routeAheadBounds(geometry, 0, 250);
    expect(b).not.toBeNull();
    expect(b?.west).toBeCloseTo(0, 6);
    expect(b?.east).toBeCloseTo(0.002, 6);
  });

  it("returns null when nothing is in range", () => {
    expect(routeAheadBounds(geometry, 100_000, 1000)).toBeNull();
  });
});

/** Metres of longitude per degree at `latDeg`. */
function metersPerDegLon(latDeg: number): number {
  return 111_320 * Math.cos((latDeg * Math.PI) / 180);
}

/** A straight west→east route at `latDeg`, `meters` long, with `points` vertices. */
function straightRoute(latDeg: number, meters: number, points = 50): LngLat[] {
  const dLonTotal = meters / metersPerDegLon(latDeg);
  return Array.from(
    { length: points },
    (_, i) => [(dLonTotal * i) / (points - 1), latDeg] as LngLat,
  );
}

/** A due-north route at `lonDeg`, spanning `fromLat`..`toLat`, with `points` vertices. */
function northSouthRoute(lonDeg: number, fromLat: number, toLat: number, points = 50): LngLat[] {
  return Array.from(
    { length: points },
    (_, i) => [lonDeg, fromLat + ((toLat - fromLat) * i) / (points - 1)] as LngLat,
  );
}

/** True when every box's `west <= east` and both fall inside [-180, 180]. */
function allNonWrapping(boxes: { west: number; east: number }[]): boolean {
  return boxes.every((b) => b.west <= b.east && b.west >= -180 && b.east <= 180);
}

describe("paddedRouteAheadBounds", () => {
  it("bounds a 60 km route at several progress values with interpolated, padded edges", () => {
    const route = straightRoute(50, 60_000, 400);
    for (const from of [0, 10_000, 25_000, 45_000, 59_000]) {
      const boxes = paddedRouteAheadBounds(route, from, 25_000);
      expect(boxes).not.toBeNull();
      expect(boxes).toHaveLength(1);
      const [box] = boxes ?? [];
      expect(box.west).toBeLessThanOrEqual(box.east);
      expect(box.south).toBeLessThanOrEqual(box.north);
      // The window must reach at least as far as an unpadded scan would.
      const plain = routeAheadBounds(route, from, 25_000);
      if (plain) {
        expect(box.west).toBeLessThanOrEqual(plain.west);
        expect(box.east).toBeGreaterThanOrEqual(plain.east);
      }
    }
  });

  it("covers the window even when a single edge spans (or exceeds) it entirely", () => {
    // Two vertices, 200 km apart: no original vertex ever falls inside a
    // 2,000 m window in the middle of that edge, so the plain `routeAheadBounds`
    // finds nothing here (this is the gap this helper exists to close).
    const route: LngLat[] = [
      [0, 50],
      [200_000 / metersPerDegLon(50), 50],
    ];
    expect(routeAheadBounds(route, 1000, 2000)).toBeNull();

    const boxes = paddedRouteAheadBounds(route, 1000, 2000);
    expect(boxes).not.toBeNull();
    const [box] = boxes ?? [];
    // The window (1,000 m to 3,000 m along) plus 250 m padding on each side,
    // converted back to metres, should land close to 750..3,250 m — nowhere
    // near the edge's full 200 km span.
    const westMeters = box.west * metersPerDegLon(50);
    const eastMeters = box.east * metersPerDegLon(50);
    expect(westMeters).toBeGreaterThan(0);
    expect(westMeters).toBeLessThan(1000);
    expect(eastMeters).toBeGreaterThan(3000);
    expect(eastMeters).toBeLessThan(4000);
  });

  it("bounds a winding, doubling-back route by along-route distance rather than physical proximity", () => {
    // Advances, retreats, then advances past its previous extent — cumulative
    // distance is still monotonic even though the x-coordinate is not.
    const route: LngLat[] = [0, 1000, 400, 1400, 900, 2200].map(
      (eastMeters) => [eastMeters / metersPerDegLon(50), 50] as LngLat,
    );
    const boxes = paddedRouteAheadBounds(route, 500, 1000);
    expect(boxes).not.toBeNull();
    const [box] = boxes ?? [];
    expect(Number.isFinite(box.west)).toBe(true);
    expect(Number.isFinite(box.east)).toBe(true);
    expect(box.west).toBeLessThanOrEqual(box.east);
  });

  it("stays finite at high latitude (~78°) instead of blowing up the longitude padding", () => {
    const route = straightRoute(78, 20_000, 100);
    const boxes = paddedRouteAheadBounds(route, 5000, 10_000);
    expect(boxes).not.toBeNull();
    const [box] = boxes ?? [];
    expect(Number.isFinite(box.west)).toBe(true);
    expect(Number.isFinite(box.east)).toBe(true);
    expect(Number.isFinite(box.south)).toBe(true);
    expect(Number.isFinite(box.north)).toBe(true);
    expect(box.north).toBeLessThanOrEqual(90);
    expect(box.south).toBeGreaterThanOrEqual(-90);
  });

  it("bounds an equator-crossing route with both a negative south and a positive north", () => {
    const route = northSouthRoute(10, -0.5, 0.5, 100);
    const total = (0.5 - -0.5) * 110_540;
    const boxes = paddedRouteAheadBounds(route, total / 2 - 5000, 10_000);
    expect(boxes).not.toBeNull();
    const [box] = boxes ?? [];
    expect(box.south).toBeLessThan(0);
    expect(box.north).toBeGreaterThan(0);
  });

  it("splits a dateline-crossing window into non-wrapping boxes that together cover the geometry", () => {
    const route: LngLat[] = [
      [179.99, 10],
      [179.995, 10],
      [-179.995, 10],
      [-179.99, 10],
    ];
    const boxes = paddedRouteAheadBounds(route, 0, 5000);
    expect(boxes).not.toBeNull();
    const list = boxes ?? [];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.length).toBeLessThanOrEqual(2);
    expect(allNonWrapping(list)).toBe(true);
    // Every geometry longitude must fall inside one of the returned boxes.
    for (const [lng] of route) {
      const covered = list.some((box) => lng >= box.west - 1e-9 && lng <= box.east + 1e-9);
      expect(covered).toBe(true);
    }
  });

  it("returns null for degenerate input instead of throwing", () => {
    expect(paddedRouteAheadBounds([], 0, 1000)).toBeNull();
    expect(paddedRouteAheadBounds([[0, 0]], 0, 1000)).toBeNull();
    expect(
      paddedRouteAheadBounds(
        [
          [0, 0],
          [Number.NaN, 1],
        ],
        0,
        1000,
      ),
    ).toBeNull();
    expect(
      paddedRouteAheadBounds(
        [
          [0, 0],
          [1, Number.POSITIVE_INFINITY],
        ],
        0,
        1000,
      ),
    ).toBeNull();
    expect(paddedRouteAheadBounds(geometry, Number.NaN, 1000)).toBeNull();
    expect(paddedRouteAheadBounds(geometry, 0, Number.NaN)).toBeNull();
  });

  it("widens the box by approximately the padding distance at a known latitude", () => {
    const route = straightRoute(52, 5000, 20);
    const unpadded = paddedRouteAheadBounds(route, 1000, 2000, 0);
    const padded = paddedRouteAheadBounds(route, 1000, 2000, DEFAULT_CORRIDOR_PAD_METERS);
    expect(unpadded).not.toBeNull();
    expect(padded).not.toBeNull();
    const [u] = unpadded ?? [];
    const [p] = padded ?? [];
    const westWidenMeters = (u.west - p.west) * metersPerDegLon(52);
    const northWidenMeters = (p.north - u.north) * 110_540;
    expect(westWidenMeters).toBeGreaterThan(DEFAULT_CORRIDOR_PAD_METERS * 0.9);
    expect(westWidenMeters).toBeLessThan(DEFAULT_CORRIDOR_PAD_METERS * 1.1);
    expect(northWidenMeters).toBeGreaterThan(DEFAULT_CORRIDOR_PAD_METERS * 0.9);
    expect(northWidenMeters).toBeLessThan(DEFAULT_CORRIDOR_PAD_METERS * 1.1);
  });
});

describe("progressBucket", () => {
  it("buckets along-route distance into stable 5 km windows", () => {
    expect(PROGRESS_BUCKET_METERS).toBe(5000);
    expect(progressBucket(0)).toBe(0);
    expect(progressBucket(4999)).toBe(0);
    expect(progressBucket(5000)).toBe(1);
    expect(progressBucket(5001)).toBe(1);
    expect(progressBucket(12_345)).toBe(2);
  });

  it("is not churned by a few metres of GPS noise moving the position back and forth", () => {
    const base = 12_345;
    expect(progressBucket(base)).toBe(progressBucket(base + 3));
    expect(progressBucket(base)).toBe(progressBucket(base - 3));
  });

  it("recovers the bucket's start distance", () => {
    expect(progressBucketStartMeters(0)).toBe(0);
    expect(progressBucketStartMeters(1)).toBe(5000);
    expect(progressBucketStartMeters(2)).toBe(10_000);
    expect(progressBucketStartMeters(progressBucket(12_345))).toBe(10_000);
  });
});
