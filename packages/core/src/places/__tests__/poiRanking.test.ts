import { describe, expect, it } from "vitest";
import type { PoiSearchResult } from "../../types/category";
import { rankAndLimitPoiResults, rankPoiResults } from "../poiRanking";

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

  it("spreads the capped selection across the bbox instead of taking the nearest cluster", () => {
    // A tight cluster at the centre, plus one outlier in each bbox corner. A
    // pure nearest-first cap would spend the whole budget on the cluster.
    const cluster = Array.from({ length: 40 }, (_, index) =>
      place(`cluster-${index}`, `Cluster ${index}`, [6.1 + index / 100_000, 50.75]),
    );
    const corners = [
      place("nw", "North West", [6.01, 50.79]),
      place("ne", "North East", [6.19, 50.79]),
      place("sw", "South West", [6.01, 50.71]),
      place("se", "South East", [6.19, 50.71]),
    ];

    const results = rankAndLimitPoiResults([...cluster, ...corners], BBOX, 10);

    expect(results).toHaveLength(10);
    for (const corner of corners) {
      expect(results.map((result) => result.id)).toContain(corner.id);
    }
  });

  it("keeps the ranked order within the spread selection", () => {
    const spread = Array.from({ length: 30 }, (_, index) =>
      place(`p-${index}`, `Place ${index}`, [6.01 + index * 0.006, 50.71 + index * 0.003]),
    );
    const uncapped = rankAndLimitPoiResults(spread, BBOX, spread.length).map((r) => r.id);
    const capped = rankAndLimitPoiResults(spread, BBOX, 8).map((r) => r.id);

    expect(capped).toHaveLength(8);
    // The spread selection decides membership only; sequence stays as ranked.
    expect(uncapped.filter((id) => capped.includes(id))).toEqual(capped);
  });
});

describe("rankPoiResults", () => {
  it("reports the pre-cap total and flags truncation", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      place(`p-${index}`, `Place ${index}`, [6.01 + index * 0.006, 50.71 + index * 0.003]),
    );
    expect(rankPoiResults(many, BBOX, 10)).toMatchObject({ total: 30, truncated: true });
  });

  it("counts distinct results, so deduplicated records do not inflate the total", () => {
    const original = place("a", "Café Central", [6.1, 50.75]);
    const duplicate = place("b", "Cafe Central", [6.1, 50.75]);
    expect(rankPoiResults([original, duplicate], BBOX, 10)).toMatchObject({
      total: 1,
      truncated: false,
    });
  });

  it("does not flag truncation when everything fits", () => {
    const few = [place("a", "A", [6.1, 50.75]), place("b", "B", [6.11, 50.76])];
    expect(rankPoiResults(few, BBOX, 10)).toMatchObject({ total: 2, truncated: false });
  });
});
