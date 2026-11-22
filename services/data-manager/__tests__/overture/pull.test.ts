import { describe, expect, it } from "vitest";
import {
  assertValidOvertureRelease,
  assertValidRegion,
  discoverLatestOvertureRelease,
  fetchRegionBoundary,
  latestReleaseFromCatalog,
  parseOsmosisPoly,
  regionEnvelopes,
  regionSlug,
  ringsToMultiPolygonWkt,
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

describe("parseOsmosisPoly", () => {
  it("parses scientific notation, named headers, exclusion rings, CRLF, duplicate consecutive vertices, and unclosed rings", () => {
    const poly = [
      "south-africa",
      "",
      "main_land",
      "   1.650000E+01  -3.480000E+01",
      "   1.650000E+01  -3.480000E+01",
      "   3.290000E+01  -3.480000E+01",
      "   3.290000E+01  -2.210000E+01",
      "   1.650000E+01  -2.210000E+01",
      "END",
      "!lesotho",
      "   27.0  -30.7",
      "   29.5  -30.7",
      "   29.5  -28.6",
      "   27.0  -28.6",
      "   27.0  -30.7",
      "END",
      "END",
      "",
    ].join("\r\n");

    const parsed = parseOsmosisPoly(poly);
    expect(parsed.outer).toHaveLength(1);
    expect(parsed.exclusions).toHaveLength(1);
    expect(parsed.outer[0]).toEqual([
      [16.5, -34.8],
      [32.9, -34.8],
      [32.9, -22.1],
      [16.5, -22.1],
      [16.5, -34.8],
    ]);
    expect(parsed.exclusions[0]).toEqual([
      [27, -30.7],
      [29.5, -30.7],
      [29.5, -28.6],
      [27, -28.6],
      [27, -30.7],
    ]);
    expect(parsed.vertices).toBe(8);
    expect(ringsToMultiPolygonWkt(parsed.outer)).toBe(
      "MULTIPOLYGON(((16.5 -34.8,32.9 -34.8,32.9 -22.1,16.5 -22.1,16.5 -34.8)))",
    );
  });

  it("fails closed on malformed, incomplete, out-of-range, or oversized .poly files", () => {
    expect(() => parseOsmosisPoly("none\nEND\n")).toThrow(/No outer rings/);
    expect(() => parseOsmosisPoly("none\n1\n0 0\n1 0\n1 1\nEND\n")).toThrow(/missing final END/);
    expect(() => parseOsmosisPoly("none\n1\n0 0\n1 0\n1 1\n")).toThrow(/missing END/);
    expect(() => parseOsmosisPoly("none\n1\n0 0\n1 0\n1 1\nEND\nEND\njunk\n")).toThrow(
      /trailing content/,
    );
    expect(() => parseOsmosisPoly("none\n1\n0 0\n1 0\nEND\nEND\n")).toThrow(
      /fewer than 3 distinct/,
    );
    expect(() => parseOsmosisPoly("none\n1\n181 0\n1 0\n1 1\nEND\nEND\n")).toThrow(
      /Invalid coordinate/,
    );
    expect(() => parseOsmosisPoly("none\n1\n0x0A 0\n1 0\n1 1\nEND\nEND\n")).toThrow(
      /Invalid coordinate line/,
    );
    expect(() => parseOsmosisPoly("none\n0 0\n1 0\n1 1\nEND\nEND\n")).toThrow(
      /Missing ring section header/,
    );
    expect(() => parseOsmosisPoly("none\n!\n0 0\n1 0\n1 1\nEND\nEND\n")).toThrow(/empty exclusion/);
    expect(() => parseOsmosisPoly("none\n!only_hole\n0 0\n1 0\n1 1\nEND\nEND\n")).toThrow(
      /No outer rings/,
    );
    expect(() => parseOsmosisPoly("a".repeat(1024 * 1024 + 1))).toThrow(/exceeds/);
  });
});

describe("regionEnvelopes", () => {
  it("returns one envelope for ordinary regions", () => {
    const parsed = parseOsmosisPoly(
      [
        "berlin",
        "1",
        "13.08 52.33",
        "13.76 52.33",
        "13.76 52.68",
        "13.08 52.68",
        "END",
        "END",
      ].join("\n"),
    );
    expect(regionEnvelopes(parsed.outer)).toEqual([
      { west: 13.08, south: 52.33, east: 13.76, north: 52.68 },
    ]);
  });

  it("splits antimeridian regions (Fiji and New Zealand shapes) into two disjoint envelopes", () => {
    const fiji = parseOsmosisPoly(
      [
        "fiji",
        "1",
        "177.1 -19.0",
        "180.0 -19.0",
        "180.0 -16.0",
        "177.1 -16.0",
        "END",
        "2",
        "-180.0 -19.5",
        "-178.4 -19.5",
        "-178.4 -16.2",
        "-180.0 -16.2",
        "END",
        "END",
      ].join("\n"),
    );
    expect(regionEnvelopes(fiji.outer)).toEqual([
      { west: -180, south: -19.5, east: -178.4, north: -16.2 },
      { west: 177.1, south: -19, east: 180, north: -16 },
    ]);

    const nz = parseOsmosisPoly(
      [
        "new-zealand",
        "1",
        "166.4 -47.3",
        "179.9999 -47.3",
        "179.9999 -34.1",
        "166.4 -34.1",
        "END",
        "2",
        "-179.989 -44.4",
        "-176.1 -44.4",
        "-176.1 -43.5",
        "-179.989 -43.5",
        "END",
        "END",
      ].join("\n"),
    );
    expect(regionEnvelopes(nz.outer)).toEqual([
      { west: -179.989, south: -44.4, east: -176.1, north: -43.5 },
      { west: 166.4, south: -47.3, east: 179.9999, north: -34.1 },
    ]);
  });

  it("keeps a single >180-degree ring (Antarctica) as one envelope", () => {
    const antarctica = parseOsmosisPoly(
      ["antarctica", "1", "-180 -85", "180 -85", "180 -60", "-180 -60", "END", "END"].join("\n"),
    );
    expect(regionEnvelopes(antarctica.outer)).toEqual([
      { west: -180, south: -85, east: 180, north: -60 },
    ]);
  });

  it("splits across the largest longitudinal gap when three or more disjoint x-spans exist", () => {
    const multiSpan = parseOsmosisPoly(
      [
        "multi",
        "1",
        "-178 19",
        "-155 19",
        "-155 22",
        "-178 22",
        "END",
        "2",
        "-125 24",
        "-67 24",
        "-67 49",
        "-125 49",
        "END",
        "3",
        "172 51",
        "180 51",
        "180 55",
        "172 55",
        "END",
        "END",
      ].join("\n"),
    );
    expect(regionEnvelopes(multiSpan.outer)).toEqual([
      { west: -178, south: 19, east: -67, north: 49 },
      { west: 172, south: 51, east: 180, north: 55 },
    ]);
  });
});

describe("fetchRegionBoundary", () => {
  it("resolves planet without contacting Geofabrik", async () => {
    await expect(fetchRegionBoundary("planet")).resolves.toEqual({
      kind: "none",
      envelopes: [{ west: -180, south: -90, east: 180, north: 90 }],
      clip: { kind: "none" },
    });
  });

  it("fetches the canonical Geofabrik .poly URL and records clip metadata", async () => {
    let seenUrl = "";
    const boundary = await fetchRegionBoundary("europe/germany/berlin", async (url) => {
      seenUrl = url;
      return ["berlin", "1", "13.1 52.3", "13.7 52.3", "13.7 52.7", "13.1 52.7", "END", "END"].join(
        "\n",
      );
    });
    expect(seenUrl).toBe("https://download.geofabrik.de/europe/germany/berlin/berlin.poly");
    expect(boundary.kind).toBe("geofabrik-poly");
    expect(boundary.clip).toMatchObject({
      kind: "geofabrik-poly",
      url: "https://download.geofabrik.de/europe/germany/berlin/berlin.poly",
      outerRings: 1,
      exclusionRings: 0,
      vertices: 4,
    });
    if (boundary.clip.kind === "geofabrik-poly") {
      expect(boundary.clip.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
