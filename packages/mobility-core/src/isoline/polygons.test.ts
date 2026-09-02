import { describe, expect, it } from "vitest";
import { planIsochroneLattice } from "./lattice.js";
import { traceContourRings } from "./marching-squares.js";
import { ringsToGeometry, simplifyRing } from "./polygons.js";

const LATTICE = planIsochroneLattice({
  bbox: [13.3, 52.45, 13.5, 52.55],
  maxSamples: 400,
  minSpacingMetres: 10,
});

/** Axis-aligned square ring in Mercator metres, counter-clockwise. */
function square(cx: number, cy: number, half: number): [number, number][] {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
    [cx - half, cy - half],
  ];
}

function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function pointInRingLngLat(point: [number, number], ring: number[][]): boolean {
  let contained = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      contained = !contained;
    }
  }
  return contained;
}

describe("ringsToGeometry", () => {
  it("returns null for no rings", () => {
    expect(ringsToGeometry([], LATTICE)).toBeNull();
  });

  it("emits a Polygon with a counter-clockwise exterior", () => {
    const geometry = ringsToGeometry([square(0, 0, 5_000)], LATTICE);
    expect(geometry?.type).toBe("Polygon");
    expect(signedArea((geometry as GeoJSON.Polygon).coordinates[0])).toBeGreaterThan(0);
  });

  it("nests a contained ring as a clockwise hole", () => {
    const geometry = ringsToGeometry([square(0, 0, 5_000), square(0, 0, 1_000)], LATTICE);
    expect(geometry?.type).toBe("Polygon");
    const rings = (geometry as GeoJSON.Polygon).coordinates;
    expect(rings).toHaveLength(2);
    expect(signedArea(rings[0])).toBeGreaterThan(0);
    expect(signedArea(rings[1])).toBeLessThan(0);
  });

  it("emits a MultiPolygon for disjoint exteriors", () => {
    const geometry = ringsToGeometry([square(0, 0, 1_000), square(50_000, 0, 1_000)], LATTICE);
    expect(geometry?.type).toBe("MultiPolygon");
    expect((geometry as GeoJSON.MultiPolygon).coordinates).toHaveLength(2);
  });

  it("emits WGS84 coordinates near the lattice", () => {
    const geometry = ringsToGeometry(
      [square(LATTICE.originX + 500, LATTICE.originY + 500, 200)],
      LATTICE,
    );
    const [lng, lat] = (geometry as GeoJSON.Polygon).coordinates[0][0];
    expect(lng).toBeGreaterThan(13);
    expect(lng).toBeLessThan(14);
    expect(lat).toBeGreaterThan(52);
    expect(lat).toBeLessThan(53);
  });
});

describe("simplifyRing", () => {
  it("drops collinear staircase points", () => {
    const ring: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
      [0, 3],
      [0, 0],
    ];
    expect(simplifyRing(ring, 0.5).length).toBeLessThan(ring.length);
  });

  it("keeps the ring closed", () => {
    const ring = square(0, 0, 1_000);
    const simplified = simplifyRing(ring, 100);
    expect(simplified[0]).toEqual(simplified[simplified.length - 1]);
  });

  it("never returns fewer than four positions", () => {
    const ring = square(0, 0, 10);
    expect(simplifyRing(ring, 1_000).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a ring simple: simplification never introduces a self-intersection", () => {
    const spiky: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 0.1],
      [0, 10],
      [0, 0],
    ];
    const simplified = simplifyRing(spiky, 5);
    for (let i = 0; i < simplified.length - 1; i += 1) {
      for (let j = i + 2; j < simplified.length - 1; j += 1) {
        if (i === 0 && j === simplified.length - 2) continue;
        const orient = (p: number[], q: number[], r: number[]) =>
          Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        const [a, b, c, d] = [simplified[i], simplified[i + 1], simplified[j], simplified[j + 1]];
        const crosses = orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
        expect(crosses).toBe(false);
      }
    }
  });
});

describe("contour nesting", () => {
  it("keeps a lower threshold strictly inside a higher one", () => {
    const centreColumn = (LATTICE.nx - 1) / 2;
    const centreRow = (LATTICE.ny - 1) / 2;
    const field: (number | null)[] = [];
    for (let row = 0; row < LATTICE.ny; row += 1) {
      for (let column = 0; column < LATTICE.nx; column += 1) {
        field.push(Math.hypot(column - centreColumn, row - centreRow) * 100);
      }
    }
    const inner = ringsToGeometry(traceContourRings(field, LATTICE, 200), LATTICE);
    const outer = ringsToGeometry(traceContourRings(field, LATTICE, 500), LATTICE);
    const innerRing = (inner as GeoJSON.Polygon).coordinates[0];
    const outerRing = (outer as GeoJSON.Polygon).coordinates[0];
    for (const vertex of innerRing) {
      expect(pointInRingLngLat(vertex as [number, number], outerRing)).toBe(true);
    }
  });
});
