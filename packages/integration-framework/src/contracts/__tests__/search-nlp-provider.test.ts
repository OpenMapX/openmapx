import { describe, expect, it } from "vitest";
import type { SearchIntent } from "../search-nlp-provider.js";
import { isPlausibleNlSearch } from "../search-nlp-provider.js";

function makeIntent(overrides: Partial<SearchIntent>): SearchIntent {
  return {
    filter: {
      selectors: [],
    },
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
  it("returns false when confidence is below the floor and filter has no selectors", () => {
    const intent = makeIntent({ confidence: 0.2, filter: { selectors: [] } });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns true when confidence is above the floor and filter has selectors", () => {
    const intent = makeIntent({
      confidence: 0.9,
      filter: { selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }] },
    });
    expect(isPlausibleNlSearch(intent)).toBe(true);
  });

  it("returns false when confidence meets the floor but filter has no selectors", () => {
    const intent = makeIntent({ confidence: 0.9, filter: { selectors: [] } });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns false when filter has selectors but confidence is below the floor", () => {
    const intent = makeIntent({
      confidence: 0.39,
      filter: { selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }] },
    });
    expect(isPlausibleNlSearch(intent)).toBe(false);
  });

  it("returns true when confidence is exactly at the floor and filter has selectors", () => {
    const intent = makeIntent({
      confidence: 0.4,
      filter: { selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }] },
    });
    expect(isPlausibleNlSearch(intent)).toBe(true);
  });
});
