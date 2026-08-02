import { describe, expect, it } from "vitest";
import {
  MAX_VALHALLA_EXCLUDE_LOCATIONS,
  MAX_VALHALLA_POLYGON_VERTICES,
  MAX_VALHALLA_POLYGON_VERTICES_PER_RING,
  sanitizeValhallaExclusions,
  ValhallaExclusionError,
} from "./valhalla-exclusions";

describe("sanitizeValhallaExclusions", () => {
  it("subsamples locations below Valhalla's hard limit", () => {
    const points = Array.from({ length: 100 }, (_, index) => [index / 100, 50] as [number, number]);
    const result = sanitizeValhallaExclusions({ points });

    expect(result.points).toHaveLength(MAX_VALHALLA_EXCLUDE_LOCATIONS);
    expect(result.points[0]).toEqual(points[0]);
    expect(result.stats.pointsSubsampled).toBe(true);
  });

  it("closes and preserves small polygon rings", () => {
    const ring: [number, number][] = [
      [6, 50],
      [6.1, 50],
      [6.1, 50.1],
    ];
    const result = sanitizeValhallaExclusions({ polygons: [ring] });

    expect(result.polygons).toEqual([[...ring, ring[0]]]);
    expect(result.stats.polygonsSimplified).toBe(0);
  });

  it("simplifies a very detailed polygon within both safety budgets", () => {
    const ring: [number, number][] = [];
    const vertices = 2_000;
    for (let index = 0; index < vertices; index++) {
      const angle = (index / vertices) * Math.PI * 2;
      ring.push([6 + Math.cos(angle) * 0.1, 50 + Math.sin(angle) * 0.1]);
    }
    ring.push(ring[0] as [number, number]);

    const result = sanitizeValhallaExclusions({ polygons: [ring] });

    expect(result.polygons[0]?.length).toBeLessThanOrEqual(MAX_VALHALLA_POLYGON_VERTICES_PER_RING);
    expect(result.stats.outputPolygonVertexCount).toBeLessThanOrEqual(
      MAX_VALHALLA_POLYGON_VERTICES,
    );
    expect(result.stats.polygonsSimplified).toBe(1);
  });

  it("refuses an unrepresentable number of polygon rings instead of dropping closures", () => {
    const polygons = Array.from({ length: 257 }, (_, index) => {
      const lng = 6 + index / 10_000;
      return [
        [lng, 50],
        [lng + 0.001, 50],
        [lng + 0.001, 50.001],
        [lng, 50],
      ] as [number, number][];
    });

    expect(() => sanitizeValhallaExclusions({ polygons })).toThrow(ValhallaExclusionError);
  });
});
