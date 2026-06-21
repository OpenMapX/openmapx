import { describe, expect, it } from "vitest";
import { resolveOsmMd5Url, resolveOsmPolyUrl, resolveOsmUrl } from "../src/jobs/download-osm.js";

describe("resolveOsmUrl", () => {
  it("returns Planet URL for 'planet'", () => {
    expect(resolveOsmUrl("planet")).toBe(
      "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf",
    );
  });

  it("returns Geofabrik URL for region", () => {
    expect(resolveOsmUrl("europe/germany")).toBe(
      "https://download.geofabrik.de/europe/germany-latest.osm.pbf",
    );
  });

  it("returns Geofabrik URL for nested region", () => {
    expect(resolveOsmUrl("north-america/us/california")).toBe(
      "https://download.geofabrik.de/north-america/us/california-latest.osm.pbf",
    );
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmUrl("")).toThrow();
  });
});

describe("resolveOsmPolyUrl", () => {
  it("returns the Geofabrik .poly boundary URL for a region path", () => {
    expect(resolveOsmPolyUrl("europe/germany/berlin")).toBe(
      "https://download.geofabrik.de/europe/germany/berlin.poly",
    );
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmPolyUrl("")).toThrow();
  });

  it("rejects planet (no Geofabrik .poly)", () => {
    expect(() => resolveOsmPolyUrl("planet")).toThrow(/planet/);
  });
});

describe("resolveOsmMd5Url", () => {
  it("appends .md5 to the PBF URL for checksum verification", () => {
    expect(resolveOsmMd5Url(resolveOsmUrl("europe/germany"))).toBe(
      "https://download.geofabrik.de/europe/germany-latest.osm.pbf.md5",
    );
    expect(resolveOsmMd5Url(resolveOsmUrl("planet"))).toBe(
      "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf.md5",
    );
  });
});
