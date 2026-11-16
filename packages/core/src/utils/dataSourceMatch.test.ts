import { describe, expect, it } from "vitest";
import type { LngLat } from "../types/geometry";
import { DATA_SOURCE_MATCH_METERS, matchDataSourceResults } from "./dataSourceMatch";

/** Metres north of the origin, in degrees of latitude. */
const north = (meters: number): LngLat => [9, 48 + meters / 111_320];

const result = (id: string, coordinates: LngLat, operator?: string) => ({
  id,
  coordinates,
  ...(operator ? { operator } : {}),
});

describe("matchDataSourceResults", () => {
  it("matches a candidate to the closest result within the distance", () => {
    const matches = matchDataSourceResults(
      [{ id: "osm", coordinates: north(0) }],
      [result("far", north(80)), result("near", north(20))],
    );
    expect(matches.get("osm")?.id).toBe("near");
  });

  it("leaves a candidate unmatched when every result is too far away", () => {
    const matches = matchDataSourceResults(
      [{ id: "osm", coordinates: north(0) }],
      [result("other", north(DATA_SOURCE_MATCH_METERS + 20))],
    );
    expect(matches.has("osm")).toBe(false);
  });

  it("gives each of two stations across a road its own result", () => {
    // Both candidates lie within reach of both results; each keeps its own.
    const matches = matchDataSourceResults(
      [
        { id: "east", coordinates: north(0) },
        { id: "west", coordinates: north(70) },
      ],
      [result("west-price", north(65)), result("east-price", north(5))],
    );
    expect(matches.get("east")?.id).toBe("east-price");
    expect(matches.get("west")?.id).toBe("west-price");
  });

  it("never lends a neighbour's result to a station the source lacks", () => {
    // Only the east station is in the source; the west one stays unmatched
    // instead of borrowing the east station's price.
    const matches = matchDataSourceResults(
      [
        { id: "west", coordinates: north(60) },
        { id: "east", coordinates: north(0) },
      ],
      [result("east-price", north(2))],
    );
    expect(matches.get("east")?.id).toBe("east-price");
    expect(matches.has("west")).toBe(false);
  });

  it("does not match across different brands", () => {
    const matches = matchDataSourceResults(
      [{ id: "osm", coordinates: north(0), brand: "Shell" }],
      [result("aral", north(10), "ARAL")],
    );
    expect(matches.has("osm")).toBe(false);
  });

  it("matches brands that differ only in case, spacing or a suffix", () => {
    const matches = matchDataSourceResults(
      [
        { id: "a", coordinates: north(0), brand: "Aral" },
        { id: "b", coordinates: north(2000), brand: "Shell" },
      ],
      [result("aral", north(10), "ARAL"), result("shell", north(2010), "Shell Deutschland")],
    );
    expect(matches.get("a")?.id).toBe("aral");
    expect(matches.get("b")?.id).toBe("shell");
  });

  it("matches when only one side names a brand", () => {
    const matches = matchDataSourceResults(
      [{ id: "osm", coordinates: north(0), brand: "Jet" }],
      [result("unbranded", north(30))],
    );
    expect(matches.get("osm")?.id).toBe("unbranded");
  });
});
