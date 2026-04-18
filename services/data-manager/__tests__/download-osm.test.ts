import { describe, expect, it } from "vitest";
import { resolveOsmUrl } from "../src/jobs/download-osm.js";

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
