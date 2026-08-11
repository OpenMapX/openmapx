import { describe, expect, it } from "vitest";
import type { CategoryPlace } from "../../types/category";
import { applyFacetFilters, brandOptions } from "../categoryFacets";

function place(id: string, brandName?: string, qid?: string): CategoryPlace {
  return {
    id,
    name: id,
    coordinates: [0, 0],
    osmTags: {
      ...(brandName && { brand: brandName }),
      ...(qid && { "brand:wikidata": qid }),
    },
  } as CategoryPlace;
}

describe("brandOptions", () => {
  it("counts places per brand, most common first", () => {
    expect(
      brandOptions([place("a", "Aldi", "Q1"), place("b", "Aldi", "Q1"), place("c", "Lidl", "Q2")]),
    ).toEqual([
      { qid: "Q1", name: "Aldi", count: 2 },
      { qid: "Q2", name: "Lidl", count: 1 },
    ]);
  });

  it("skips places with no brand QID", () => {
    expect(brandOptions([place("a"), place("b", "Corner Shop")])).toEqual([]);
  });

  it("falls back to the QID when no brand name tag is present", () => {
    expect(brandOptions([place("a", undefined, "Q1")])).toEqual([
      { qid: "Q1", name: "Q1", count: 1 },
    ]);
  });
});

describe("brand facet filtering", () => {
  it("keeps only the selected brands", () => {
    const results = [place("a", "Aldi", "Q1"), place("b", "Lidl", "Q2")];
    expect(applyFacetFilters(results, { brand: ["Q1"] }).map((p) => p.id)).toEqual(["a"]);
  });

  it("keeps every selected brand when more than one is chosen", () => {
    const results = [place("a", "Aldi", "Q1"), place("b", "Lidl", "Q2"), place("c", "Rewe", "Q3")];
    expect(applyFacetFilters(results, { brand: ["Q1", "Q3"] }).map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("is inactive when nothing is selected", () => {
    const results = [place("a", "Aldi", "Q1"), place("b")];
    expect(applyFacetFilters(results, {})).toHaveLength(2);
  });
});
