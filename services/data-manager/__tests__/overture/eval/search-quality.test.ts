import { describe, expect, it } from "vitest";
import { evaluateSearchQuality } from "../../../src/jobs/overture/eval/search-quality.js";

describe("evaluateSearchQuality", () => {
  it("measures ranked relevance, recall, and duplicates", () => {
    const metrics = evaluateSearchQuality([
      {
        query: "cafes in Aachen",
        totalRelevant: 3,
        results: [
          { id: "a", relevant: true },
          { id: "b", relevant: false },
          { id: "c", relevant: true },
          { id: "d", relevant: true, duplicateOf: "a" },
        ],
      },
    ]);
    expect(metrics).toEqual({
      cases: 1,
      precisionAt50: 0.75,
      recallAt50: 1,
      meanReciprocalRank: 1,
      duplicateRate: 0.25,
    });
  });

  it("defines stable empty-input metrics", () => {
    expect(evaluateSearchQuality([])).toEqual({
      cases: 0,
      precisionAt50: 0,
      recallAt50: 0,
      meanReciprocalRank: 0,
      duplicateRate: 0,
    });
  });
});
