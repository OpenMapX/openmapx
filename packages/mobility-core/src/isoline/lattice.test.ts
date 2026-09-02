import { describe, expect, it } from "vitest";
import { fromWebMercator, toWebMercator } from "../mercator.js";
import type { BBox } from "../types/geometry.js";
import { latticePointAt, planIsochroneLattice } from "./lattice.js";

const BERLIN: BBox = [13.2, 52.4, 13.6, 52.6];

describe("toWebMercator", () => {
  it("round-trips a coordinate", () => {
    const [x, y] = toWebMercator(13.4, 52.5);
    const [lng, lat] = fromWebMercator(x, y);
    expect(lng).toBeCloseTo(13.4, 9);
    expect(lat).toBeCloseTo(52.5, 9);
  });

  it("clamps latitude to the Mercator limit", () => {
    expect(Number.isFinite(toWebMercator(0, 89.9)[1])).toBe(true);
  });
});

describe("planIsochroneLattice", () => {
  it("derives spacing from the sample budget", () => {
    const lattice = planIsochroneLattice({ bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 });
    expect(lattice.spacing).toBeGreaterThan(100);
    expect(lattice.nx * lattice.ny).toBeLessThanOrEqual(2048);
  });

  it("is deterministic for the same input", () => {
    const options = { bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 } as const;
    expect(planIsochroneLattice(options)).toEqual(planIsochroneLattice(options));
  });

  it("snaps the origin to a global multiple of the spacing so neighbours share a grid", () => {
    const lattice = planIsochroneLattice({ bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 });
    // The property is that origin/spacing is a whole number of cells from the
    // projection origin. Asserting on `%` instead would be flaky: for a value a
    // hair below k*spacing the remainder comes back as ~spacing, not ~0.
    const cellsX = lattice.originX / lattice.spacing;
    const cellsY = lattice.originY / lattice.spacing;
    expect(Math.abs(cellsX - Math.round(cellsX))).toBeLessThan(1e-6);
    expect(Math.abs(cellsY - Math.round(cellsY))).toBeLessThan(1e-6);
  });

  it("keeps the spacing on a stable ladder so a nudged viewport reuses the same lattice", () => {
    const a = planIsochroneLattice({ bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 });
    const nudged: BBox = [13.2001, 52.4001, 13.6001, 52.6001];
    const b = planIsochroneLattice({ bbox: nudged, maxSamples: 2048, minSpacingMetres: 100 });
    expect(b.spacing).toBe(a.spacing);
  });

  it("covers the whole sampled bbox", () => {
    // Against `lattice.bbox`, not the requested one: this Berlin extent exceeds
    // the default area budget, so what gets sampled is the clamped box.
    const lattice = planIsochroneLattice({ bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 });
    const [swLng, swLat] = latticePointAt(lattice, 0);
    const [neLng, neLat] = latticePointAt(lattice, lattice.nx * lattice.ny - 1);
    expect(swLng).toBeLessThanOrEqual(lattice.bbox[0]);
    expect(swLat).toBeLessThanOrEqual(lattice.bbox[1]);
    expect(neLng).toBeGreaterThanOrEqual(lattice.bbox[2] - 1e-9);
    expect(neLat).toBeGreaterThanOrEqual(lattice.bbox[3] - 1e-9);
  });

  it("measures the area budget on the ground, not in the projection", () => {
    // The same ground-sized box at two latitudes must clamp the same way.
    // Mercator area alone would inflate the northern one by 1/cos², clipping it
    // while leaving the equatorial one untouched.
    const equator: BBox = [0, 0, 0.2, 0.2];
    const north: BBox = [0, 60, 0.4, 60.1];
    expect(planIsochroneLattice({ bbox: equator, maxAreaKm2: 900 }).clipped).toBe(false);
    expect(planIsochroneLattice({ bbox: north, maxAreaKm2: 900 }).clipped).toBe(false);
  });

  it("enforces the minimum spacing on a tiny bbox instead of over-sampling", () => {
    const tiny: BBox = [13.4, 52.5, 13.42, 52.51];
    const lattice = planIsochroneLattice({ bbox: tiny, maxSamples: 2048, minSpacingMetres: 100 });
    expect(lattice.spacing).toBe(100);
  });

  it("clamps an oversized bbox around its centre and reports the clip", () => {
    const huge: BBox = [0, 40, 20, 60];
    const lattice = planIsochroneLattice({
      bbox: huge,
      maxSamples: 2048,
      minSpacingMetres: 100,
      maxAreaKm2: 900,
    });
    expect(lattice.clipped).toBe(true);
    const [west, south, east, north] = lattice.bbox;
    expect((east + west) / 2).toBeCloseTo(10, 6);
    expect((north + south) / 2).toBeCloseTo(50, 6);
  });

  it("reports ground resolution at the centre latitude", () => {
    const lattice = planIsochroneLattice({ bbox: BERLIN, maxSamples: 2048, minSpacingMetres: 100 });
    expect(lattice.resolutionMetres).toBeCloseTo(
      lattice.spacing * Math.cos((52.5 * Math.PI) / 180),
      3,
    );
  });
});

describe("latticePointAt", () => {
  it("walks row-major from the south-west corner", () => {
    const lattice = planIsochroneLattice({ bbox: BERLIN, maxSamples: 64, minSpacingMetres: 100 });
    const [lng0, lat0] = latticePointAt(lattice, 0);
    const [lng1, lat1] = latticePointAt(lattice, 1);
    expect(lng1).toBeGreaterThan(lng0);
    expect(lat1).toBeCloseTo(lat0, 9);
    const [, latRow1] = latticePointAt(lattice, lattice.nx);
    expect(latRow1).toBeGreaterThan(lat0);
  });
});
