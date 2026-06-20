import { describe, expect, it } from "vitest";
import { osmPbfName, resolveOsmMd5Url, resolveOsmUrl } from "../src/jobs/download-osm.js";

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

  it("rewrites Geofabrik-nested region aliases (Berlin under germany)", () => {
    expect(resolveOsmUrl("europe/berlin")).toBe(
      "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf",
    );
  });

  it("keeps the local PBF filename keyed on the original region for aliases", () => {
    // The URL is rewritten, but the local filename stays `europe-berlin...` so
    // callers that derive the PBF path from the same region key still find it.
    expect(osmPbfName("europe/berlin")).toBe("europe-berlin.osm.pbf");
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmUrl("")).toThrow();
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
