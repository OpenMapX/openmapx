import { describe, expect, it } from "vitest";
import {
  assertValidOvertureRelease,
  assertValidRegion,
  computeBboxFromPoly,
  discoverLatestOvertureRelease,
  latestReleaseFromCatalog,
  regionSlug,
} from "../../src/jobs/overture/pull.js";

describe("Overture release discovery", () => {
  it("reads and validates the catalog's canonical latest field", () => {
    expect(latestReleaseFromCatalog({ latest: "2026-07-22.0" })).toBe("2026-07-22.0");
    expect(() => latestReleaseFromCatalog({})).toThrow(/missing.*latest/i);
    expect(() => latestReleaseFromCatalog({ latest: "latest" })).toThrow(
      /Invalid Overture release/,
    );
  });

  it("rejects release values that could escape SQL or S3 paths", () => {
    expect(() => assertValidOvertureRelease("2026-07-22.0")).not.toThrow();
    expect(() => assertValidOvertureRelease("2026-07-22.0/*")).toThrow(/Invalid Overture release/);
    expect(() => assertValidOvertureRelease("2026-7-22.0")).toThrow(/Invalid Overture release/);
  });

  it("discovers the latest release through the official STAC catalog", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://stac.overturemaps.org/catalog.json");
      return new Response(JSON.stringify({ latest: "2026-07-22.0" }), { status: 200 });
    };
    await expect(discoverLatestOvertureRelease(fetchImpl as typeof fetch)).resolves.toBe(
      "2026-07-22.0",
    );
  });

  it("fails closed when discovery cannot produce a valid release", async () => {
    const fetchImpl = async () => new Response("unavailable", { status: 503 });
    await expect(discoverLatestOvertureRelease(fetchImpl as typeof fetch)).rejects.toThrow(
      /HTTP 503/,
    );
  });
});

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
