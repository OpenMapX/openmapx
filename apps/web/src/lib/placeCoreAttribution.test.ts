import { describe, expect, it } from "vitest";
import { buildPlaceCoreAttribution } from "./placeCoreAttribution";

describe("buildPlaceCoreAttribution", () => {
  it("credits OpenStreetMap for OSM-based places", () => {
    const html = buildPlaceCoreAttribution({
      primaryScheme: "osm",
      ids: { osm: "way/123" },
      osmTags: { leisure: "nature_reserve" },
    });
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).toContain("openstreetmap.org/copyright");
  });

  it("credits OpenStreetMap when only osmTags are present (no osm id scheme)", () => {
    const html = buildPlaceCoreAttribution({
      primaryScheme: "maptiler",
      ids: { maptiler: "abc" },
      osmTags: { amenity: "cafe" },
    });
    expect(html).toContain("OpenStreetMap contributors");
  });

  it("renders nothing for transit-stop places (credited by the transit section)", () => {
    const html = buildPlaceCoreAttribution({
      primaryScheme: "eva",
      ids: { eva: "8000105" },
    });
    expect(html).toBe("");
  });

  it("never credits transit-data providers in the generic footer", () => {
    const html = buildPlaceCoreAttribution({
      primaryScheme: "osm",
      ids: { osm: "node/9" },
      osmTags: { railway: "station" },
    });
    expect(html).not.toContain("Transitous");
    expect(html).not.toContain("MOTIS");
    expect(html).not.toContain("Entur");
  });
});
