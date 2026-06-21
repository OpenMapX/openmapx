import { describe, expect, it } from "vitest";
import {
  assertValidRegion,
  computeBboxFromPoly,
  regionSlug,
} from "../../src/jobs/overture/pull.js";

describe("assertValidRegion", () => {
  it("accepts well-formed Geofabrik-style regions", () => {
    expect(() => assertValidRegion("europe/berlin")).not.toThrow();
    expect(() => assertValidRegion("europe/germany")).not.toThrow();
    expect(() => assertValidRegion("north-america/us/texas")).not.toThrow();
    expect(() => assertValidRegion("germany")).not.toThrow();
  });

  it("rejects SQL/path metacharacters (injection + traversal)", () => {
    expect(() => assertValidRegion("europe/berlin'; DROP TABLE x; --")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("../../etc/passwd")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("europe/berlin.parquet")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("europe/ber lin")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("europe//berlin")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("Europe/Berlin")).toThrow(/Invalid region/);
    expect(() => assertValidRegion("")).toThrow(/Invalid region/);
  });
});

describe("regionSlug", () => {
  it("slugs a valid region by replacing slashes", () => {
    expect(regionSlug("europe/berlin")).toBe("europe-berlin");
    expect(regionSlug("north-america/us/texas")).toBe("north-america-us-texas");
  });

  it("validates the region before slugging (rejects injection)", () => {
    expect(() => regionSlug("europe/berlin'; DROP TABLE x; --")).toThrow(/Invalid region/);
  });
});

describe("computeBboxFromPoly", () => {
  // A trimmed Geofabrik .poly: a name line, one ring of `lon lat` lines in
  // scientific notation, and END terminators (Berlin-shaped coordinates).
  const poly = [
    "none",
    "1",
    "   1.373096E+01   5.239455E+01",
    "   1.308280E+01   5.267830E+01",
    "   1.376220E+01   5.233450E+01",
    "   1.350000E+01   5.250000E+01",
    "END",
    "END",
  ].join("\n");

  it("derives the bounding box from .poly coordinate lines", () => {
    const bbox = computeBboxFromPoly(poly);
    expect(bbox.west).toBeCloseTo(13.0828, 3);
    expect(bbox.south).toBeCloseTo(52.3345, 3);
    expect(bbox.east).toBeCloseTo(13.7622, 3);
    expect(bbox.north).toBeCloseTo(52.6783, 3);
  });

  it("ignores the name/section-header/END lines (not 2 numeric tokens)", () => {
    // Only the four coordinate lines contribute; headers must not skew the bbox.
    const bbox = computeBboxFromPoly(poly);
    expect(bbox.north).toBeLessThan(90);
    expect(bbox.west).toBeGreaterThan(-180);
  });

  it("throws when the .poly has no coordinate lines", () => {
    expect(() => computeBboxFromPoly("none\nEND\n")).toThrow(/no coordinates/);
  });
});
