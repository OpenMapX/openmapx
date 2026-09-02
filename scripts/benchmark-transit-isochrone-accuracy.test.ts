import {
  planIsochroneLattice,
  ringsToGeometry,
  traceContourRings,
} from "@openmapx/mobility-core/isoline";
import { describe, expect, it } from "vitest";
import {
  classifySamplePoints,
  distanceToBoundaryDegrees,
  stratifiedSamplePoints,
  summariseAccuracy,
} from "./benchmark-transit-isochrone-accuracy.js";

const SQUARE: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

const WITH_HOLE: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
      [4, 4],
    ],
  ],
};

describe("classifySamplePoints", () => {
  it("marks points inside and outside the polygon", () => {
    const classified = classifySamplePoints(SQUARE, [
      { id: "in", lng: 0.5, lat: 0.5 },
      { id: "out", lng: 2, lat: 2 },
    ]);
    expect(classified.find((c) => c.id === "in")?.insidePolygon).toBe(true);
    expect(classified.find((c) => c.id === "out")?.insidePolygon).toBe(false);
  });

  it("treats a point inside a hole as outside the polygon", () => {
    const classified = classifySamplePoints(WITH_HOLE, [
      { id: "hole", lng: 5, lat: 5 },
      { id: "ring", lng: 1, lat: 1 },
    ]);
    expect(classified.find((c) => c.id === "hole")?.insidePolygon).toBe(false);
    expect(classified.find((c) => c.id === "ring")?.insidePolygon).toBe(true);
  });
});

describe("summariseAccuracy", () => {
  it("counts a point the polygon includes but MOTIS says is unreachable as a false inside", () => {
    const summary = summariseAccuracy([
      { id: "a", insidePolygon: true, exactReachable: false, cellsFromBoundary: 3 },
    ]);
    expect(summary.falseInside).toBe(1);
    expect(summary.falseOutside).toBe(0);
  });

  it("counts a point the polygon excludes but MOTIS says is reachable as a false outside", () => {
    const summary = summariseAccuracy([
      { id: "a", insidePolygon: false, exactReachable: true, cellsFromBoundary: 3 },
    ]);
    expect(summary.falseOutside).toBe(1);
  });

  it("fails the deep-inside invariant when a point well inside is unreachable", () => {
    const summary = summariseAccuracy([
      { id: "a", insidePolygon: true, exactReachable: false, cellsFromBoundary: 5 },
    ]);
    expect(summary.invariantFailures).toBe(1);
  });

  it("does not apply the invariant within two cells of the boundary", () => {
    const summary = summariseAccuracy([
      { id: "a", insidePolygon: true, exactReachable: false, cellsFromBoundary: 1 },
    ]);
    expect(summary.invariantFailures).toBe(0);
    expect(summary.nearBoundary).toBe(1);
  });

  it("reports agreement as clean regardless of distance", () => {
    const summary = summariseAccuracy([
      { id: "a", insidePolygon: true, exactReachable: true, cellsFromBoundary: 9 },
      { id: "b", insidePolygon: false, exactReachable: false, cellsFromBoundary: 0.5 },
    ]);
    expect(summary).toMatchObject({
      falseInside: 0,
      falseOutside: 0,
      nearBoundary: 0,
      invariantFailures: 0,
      total: 2,
    });
  });
});

describe("distanceToBoundaryDegrees", () => {
  it("measures to the nearest edge, not the nearest vertex", () => {
    const distance = distanceToBoundaryDegrees(SQUARE, { id: "x", lng: 0.5, lat: 0.4 });
    expect(distance).toBeCloseTo(0.4, 6);
  });
});

describe("stratifiedSamplePoints", () => {
  it("is deterministic and stays inside the bbox", () => {
    const bbox: [number, number, number, number] = [13.3, 52.45, 13.5, 52.55];
    const a = stratifiedSamplePoints(bbox, 50);
    expect(stratifiedSamplePoints(bbox, 50)).toEqual(a);
    for (const point of a) {
      expect(point.lng).toBeGreaterThanOrEqual(bbox[0]);
      expect(point.lng).toBeLessThanOrEqual(bbox[2]);
      expect(point.lat).toBeGreaterThanOrEqual(bbox[1]);
      expect(point.lat).toBeLessThanOrEqual(bbox[3]);
    }
  });
});

/**
 * The same invariant the live benchmark gates on, exercised without MOTIS.
 *
 * It runs the whole pipeline — lattice, marching squares, ring assembly,
 * winding and holes, point-in-polygon — against the field the contour was
 * derived from. A systematic error such as inverted inside/outside, a reversed
 * ring, or a hole classified as an exterior would surface here rather than
 * waiting for a deployment with real data.
 */
describe("sampled polygon agrees with its own field", () => {
  const bbox: [number, number, number, number] = [13.3, 52.45, 13.5, 52.55];
  const lattice = planIsochroneLattice({ bbox, maxSamples: 2048, minSpacingMetres: 50 });
  const threshold = 900;

  const centreColumn = (lattice.nx - 1) / 2;
  const centreRow = (lattice.ny - 1) / 2;
  const values: (number | null)[] = [];
  for (let row = 0; row < lattice.ny; row += 1) {
    for (let column = 0; column < lattice.nx; column += 1) {
      const cells = Math.hypot(column - centreColumn, row - centreRow);
      values.push(cells > 18 ? null : cells * 100);
    }
  }

  /** Ground truth read straight from the field at the nearest lattice point. */
  function reachableInField(lng: number, lat: number): boolean {
    const radius = 6_378_137;
    const x = (lng * Math.PI * radius) / 180;
    const y = radius * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const column = Math.round((x - lattice.originX) / lattice.spacing);
    const row = Math.round((y - lattice.originY) / lattice.spacing);
    if (column < 0 || column >= lattice.nx || row < 0 || row >= lattice.ny) return false;
    const value = values[row * lattice.nx + column];
    return value !== null && value <= threshold;
  }

  it("classifies deep-inside and far-outside points the way the field does", () => {
    const geometry = ringsToGeometry(traceContourRings(values, lattice, threshold), lattice);
    expect(geometry).not.toBeNull();

    const points = stratifiedSamplePoints(lattice.bbox, 400);
    const classified = classifySamplePoints(
      geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon,
      points,
    );
    const cellDegrees = lattice.resolutionMetres / 111_320;

    const summary = summariseAccuracy(
      classified.map((point) => ({
        id: point.id,
        insidePolygon: point.insidePolygon,
        exactReachable: reachableInField(point.lng, point.lat),
        cellsFromBoundary:
          distanceToBoundaryDegrees(geometry as GeoJSON.Polygon, point) / cellDegrees,
      })),
    );

    expect(summary.total).toBe(400);
    expect(summary.invariantFailures).toBe(0);
  });
});
