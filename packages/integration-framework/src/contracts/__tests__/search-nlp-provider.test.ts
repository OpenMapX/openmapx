import { describe, expect, it } from "vitest";
import type { SearchIntent } from "../search-nlp-provider.js";
import { isPlausibleNlSearch } from "../search-nlp-provider.js";

function makeIntent(overrides: Partial<SearchIntent>): SearchIntent {
  return {
    categories: [],
    attributes: {},
    spatial_constraint: null,
    time_constraint: null,
    sort_by: "relevance",
    unmapped_attributes: [],
    confidence: 0,
    explanation: "",
    ...overrides,
  };
}

describe("isPlausibleNlSearch", () => {
  it("returns false when confidence is below the floor and categories is empty", () => {
    const intent = makeIntent({ confidence: 0.2, categories: [] });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns true when confidence is above the floor and categories is non-empty", () => {
    const intent = makeIntent({ confidence: 0.9, categories: ["cafes"] });
    expect(isPlausibleNlSearch(intent)).toBe(true);
  });

  it("returns false when confidence meets the floor but categories is empty", () => {
    const intent = makeIntent({ confidence: 0.9, categories: [] });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns false when categories is non-empty but confidence is below the floor", () => {
    const intent = makeIntent({ confidence: 0.39, categories: ["cafes"] });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns true when confidence is exactly at the floor and categories is non-empty", () => {
    const intent = makeIntent({ confidence: 0.4, categories: ["cafes"] });
    expect(isPlausibleNlSearch(intent)).toBe(true);
  });
});
