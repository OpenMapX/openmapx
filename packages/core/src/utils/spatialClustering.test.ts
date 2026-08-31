import { describe, expect, it } from "vitest";
import { clusterSpatialItems } from "./spatialClustering";

interface Point {
  id: string;
  coordinates: readonly [number, number];
  group?: string;
}

const options = {
  coordinates: (point: Point) => point.coordinates,
  searchRadiusMeters: 150,
  shouldJoin: (first: Point, second: Point) => first.group === second.group,
};

describe("clusterSpatialItems", () => {
  it("returns no clusters for empty input", () => {
    expect(clusterSpatialItems([], options)).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid search radius %s",
    (searchRadiusMeters) => {
      const point: Point = { id: "only", coordinates: [13.377, 52.52] };

      expect(() => clusterSpatialItems([point], { ...options, searchRadiusMeters })).toThrow(
        RangeError,
      );
    },
  );

  it("preserves singleton identity", () => {
    const point: Point = { id: "only", coordinates: [13.377, 52.52] };

    const result = clusterSpatialItems([point], options);

    expect(result).toEqual([[point]]);
    expect(result[0][0]).toBe(point);
  });

  it("finds compatible points across adjacent buckets", () => {
    const points: Point[] = [
      { id: "west", coordinates: [13.37799, 52.52], group: "site" },
      { id: "east", coordinates: [13.37801, 52.52], group: "site" },
    ];

    expect(clusterSpatialItems(points, options)).toEqual([points]);
  });

  it("widens longitude discovery near the poles without an unbounded scan", () => {
    const points: Point[] = [
      { id: "west", coordinates: [10, 89], group: "site" },
      { id: "east", coordinates: [10.05, 89], group: "site" },
    ];

    expect(clusterSpatialItems(points, options)).toEqual([points]);
  });

  it("combines mutually compatible members transitively", () => {
    const points: Point[] = [
      { id: "first", coordinates: [13.377, 52.52], group: "site" },
      { id: "second", coordinates: [13.3772, 52.5202], group: "site" },
      { id: "third", coordinates: [13.3774, 52.5204], group: "site" },
    ];

    expect(clusterSpatialItems(points, options)).toEqual([points]);
  });

  it("does not bridge cluster members that are mutually incompatible", () => {
    const points: Point[] = [
      { id: "first", coordinates: [13.377, 52.52] },
      { id: "bridge", coordinates: [13.3772, 52.52] },
      { id: "last", coordinates: [13.3774, 52.52] },
    ];
    const shouldJoin = (first: Point, second: Point) =>
      Math.abs(points.indexOf(first) - points.indexOf(second)) === 1;

    expect(clusterSpatialItems(points, { ...options, shouldJoin })).toEqual([
      [points[0], points[1]],
      [points[2]],
    ]);
  });

  it("keeps clusters and their members in input order", () => {
    const points: Point[] = [
      { id: "b1", coordinates: [13.377, 52.52], group: "b" },
      { id: "a1", coordinates: [13.38, 52.52], group: "a" },
      { id: "b2", coordinates: [13.3772, 52.5202], group: "b" },
      { id: "a2", coordinates: [13.3802, 52.5202], group: "a" },
    ];

    expect(clusterSpatialItems(points, options)).toEqual([
      [points[0], points[2]],
      [points[1], points[3]],
    ]);
  });
});
