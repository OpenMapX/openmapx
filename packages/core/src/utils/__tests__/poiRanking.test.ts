import { describe, expect, it } from "vitest";
import type { PoiSearchResult } from "../../types/category";
import { rankAndLimitPoiResults } from "../poiRanking";

const BBOX = { south: 50.7, west: 6.0, north: 50.8, east: 6.2 };

function place(
  id: string,
  name: string,
  coordinates: [number, number],
  extra: Partial<PoiSearchResult> = {},
): PoiSearchResult {
  return { id, name, coordinates, category: "cafes", ...extra };
}

describe("rankAndLimitPoiResults", () => {
  it("orders nearest to the map centre with deterministic ties", () => {
    const results = rankAndLimitPoiResults(
      [
        place("far", "Far", [6.01, 50.71]),
        place("b", "B", [6.1, 50.75]),
        place("a", "A", [6.1, 50.75]),
      ],
      BBOX,
    );
    expect(results.map((result) => result.id)).toEqual(["a", "b", "far"]);
  });

  it("keeps the more complete coincident duplicate", () => {
    const sparse = place("overture:sparse", "Café Central", [6.1, 50.75]);
    const complete = place("overture:complete", "Cafe Central", [6.1, 50.75], {
      address: "Markt 1",
      website: "https://cafe.example",
    });
    const results = rankAndLimitPoiResults([sparse, complete], BBOX);
    expect(results).toEqual([complete]);
  });

  it("does not collapse nearby branches without corroborating identity", () => {
    const first = place("overture:1", "Tchibo", [6.1, 50.75]);
    const second = place("overture:2", "Tchibo", [6.1003, 50.75]);
    expect(rankAndLimitPoiResults([first, second], BBOX)).toHaveLength(2);
  });

  it("deduplicates nearby records with the same website and applies the cap", () => {
    const duplicateA = place("overture:a", "Example Cafe", [6.1, 50.75], {
      website: "https://www.example.com/aachen",
    });
    const duplicateB = place("overture:b", "Example Café", [6.1002, 50.75], {
      website: "https://example.com/contact",
    });
    const filler = Array.from({ length: 60 }, (_, index) =>
      place(`overture:${index}`, `Place ${index}`, [6.1 + index / 10_000, 50.75]),
    );
    const results = rankAndLimitPoiResults([duplicateA, duplicateB, ...filler], BBOX, 50);
    expect(results).toHaveLength(50);
    expect(results.filter((result) => result.name.startsWith("Example"))).toHaveLength(1);
  });
});
