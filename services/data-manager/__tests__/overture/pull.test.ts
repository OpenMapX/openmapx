import { describe, expect, it } from "vitest";
import { assertValidRegion, regionSlug, resolveRegionBbox } from "../../src/jobs/overture/pull.js";

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

describe("resolveRegionBbox", () => {
  it("returns the bbox for a known region", () => {
    expect(resolveRegionBbox("europe/berlin")).toEqual({
      west: 13.0,
      south: 52.3,
      east: 13.8,
      north: 52.7,
    });
  });

  it("throws for a region with no defined bbox", () => {
    expect(() => resolveRegionBbox("europe/atlantis")).toThrow(/No bbox defined/);
  });
});
