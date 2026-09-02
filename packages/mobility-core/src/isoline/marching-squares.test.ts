import { describe, expect, it } from "vitest";
import { planIsochroneLattice } from "./lattice.js";
import { traceContourRings } from "./marching-squares.js";

const LATTICE = planIsochroneLattice({
  bbox: [13.3, 52.45, 13.5, 52.55],
  maxSamples: 400,
  minSpacingMetres: 10,
});

/** Build a field from a function of lattice column/row. */
function field(fn: (column: number, row: number) => number | null): (number | null)[] {
  const values: (number | null)[] = [];
  for (let row = 0; row < LATTICE.ny; row += 1) {
    for (let column = 0; column < LATTICE.nx; column += 1) values.push(fn(column, row));
  }
  return values;
}

function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

const centreColumn = (LATTICE.nx - 1) / 2;
const centreRow = (LATTICE.ny - 1) / 2;
const radial = () =>
  field((column, row) => Math.hypot(column - centreColumn, row - centreRow) * 100);

describe("traceContourRings", () => {
  it("returns no rings when every value is above the threshold", () => {
    expect(
      traceContourRings(
        field(() => 9_000),
        LATTICE,
        600,
      ),
    ).toEqual([]);
  });

  it("encloses the whole sampled area when every value is below the threshold", () => {
    // The virtual unreachable border means a fully-reachable field yields a
    // ring around the sampled area rather than nothing at all.
    const rings = traceContourRings(
      field(() => 60),
      LATTICE,
      600,
    );
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it("closes a contour that runs off the sampled edge instead of discarding it", () => {
    // The reachable strip touches the west edge. Without the virtual border
    // this chain would stay open and the whole polygon would be dropped.
    const rings = traceContourRings(
      field((column) => (column < 2 ? 100 : null)),
      LATTICE,
      600,
    );
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it("traces a closed ring around a central reachable disc", () => {
    const rings = traceContourRings(radial(), LATTICE, 300);
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBeGreaterThan(8);
  });

  it("grows the ring monotonically with the threshold, which is what makes contours nest", () => {
    const small = Math.abs(ringArea(traceContourRings(radial(), LATTICE, 200)[0]));
    const large = Math.abs(ringArea(traceContourRings(radial(), LATTICE, 400)[0]));
    expect(large).toBeGreaterThan(small);
  });

  it("places the crossing at the edge midpoint when one endpoint is unreachable", () => {
    const rings = traceContourRings(
      field((column) => (column === 0 ? 100 : null)),
      LATTICE,
      600,
    );
    expect(rings.length).toBeGreaterThanOrEqual(1);
    const midpointX = LATTICE.originX + 0.5 * LATTICE.spacing;
    const crossingXs = rings
      .flat()
      .map(([x]) => x)
      .filter((x) => x > LATTICE.originX);
    expect(Math.max(...crossingXs)).toBeCloseTo(midpointX, 6);
  });

  it("does not interpolate toward an unreachable value", () => {
    // If null were coerced to a large finite number, the crossing would sit very
    // close to the reachable corner rather than at the midpoint.
    const rings = traceContourRings(
      field((column) => (column === 0 ? 599 : null)),
      LATTICE,
      600,
    );
    const midpointX = LATTICE.originX + 0.5 * LATTICE.spacing;
    const crossingXs = rings
      .flat()
      .map(([x]) => x)
      .filter((x) => x > LATTICE.originX);
    expect(Math.max(...crossingXs)).toBeCloseTo(midpointX, 6);
  });

  it("interpolates proportionally between two reachable corners", () => {
    // 300 s and 900 s across a cell, contoured at 600 s, crosses at the middle.
    const rings = traceContourRings(
      field((column) => (column === 0 ? 300 : 900)),
      LATTICE,
      600,
    );
    const midpointX = LATTICE.originX + 0.5 * LATTICE.spacing;
    const crossingXs = rings
      .flat()
      .map(([x]) => x)
      .filter((x) => x > LATTICE.originX);
    expect(Math.max(...crossingXs)).toBeCloseTo(midpointX, 6);
  });

  it("separates an ambiguous saddle when any corner is unreachable", () => {
    const rings = traceContourRings(
      field((column, row) => {
        if (column === 0 && row === 0) return 100;
        if (column === 1 && row === 1) return 100;
        if (column === 1 && row === 0) return null;
        return 9_000;
      }),
      LATTICE,
      600,
    );
    expect(rings.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a field whose length does not match the lattice", () => {
    expect(() => traceContourRings([1, 2, 3], LATTICE, 600)).toThrow(/lattice/i);
  });
});
