import { describe, expect, it } from "vitest";
import type { CategoryPlace } from "../types/category";
import {
  applyFacetFilters,
  brandOptions,
  cuisineOptions,
  facetsForCategory,
} from "./categoryFacets";

function place(id: string, osmTags?: Record<string, string>): CategoryPlace {
  return { id, name: id, coordinates: [0, 0], osmTags };
}

describe("applyFacetFilters", () => {
  it("returns everything when no facet is selected", () => {
    const results = [place("a", { wheelchair: "no" })];
    expect(applyFacetFilters(results, {})).toBe(results);
  });

  it("toggle facet keeps matching tag values (wheelchair: yes/designated/limited)", () => {
    const results = [
      place("yes", { wheelchair: "yes" }),
      place("designated", { wheelchair: "designated" }),
      place("limited", { wheelchair: "limited" }),
      place("no", { wheelchair: "no" }),
      place("none"),
    ];
    const ids = applyFacetFilters(results, { wheelchairAccessible: ["on"] }).map((p) => p.id);
    expect(ids).toEqual(["yes", "designated", "limited"]);
  });

  it("ANDs multiple active facets together", () => {
    const results = [
      place("both", { outdoor_seating: "yes", takeaway: "yes" }),
      place("onlyOutdoor", { outdoor_seating: "yes" }),
    ];
    const ids = applyFacetFilters(results, { outdoorSeating: ["on"], takeaway: ["on"] }).map(
      (p) => p.id,
    );
    expect(ids).toEqual(["both"]);
  });

  it("multi facet (cuisine) matches any selected value, honoring ; lists", () => {
    const results = [
      place("italian", { cuisine: "italian" }),
      place("pizzaKebab", { cuisine: "pizza;kebab" }),
      place("sushi", { cuisine: "sushi" }),
    ];
    const ids = applyFacetFilters(results, { cuisine: ["italian", "kebab"] }).map((p) => p.id);
    expect(ids).toEqual(["italian", "pizzaKebab"]);
  });

  it("keeps a place whose brand chip was derived from operator:wikidata, not brand:wikidata", () => {
    const results = [
      place("qpark", { "operator:wikidata": "Q1127798", operator: "Q-Park" }),
      place("other", { "operator:wikidata": "Q9999999", operator: "Someone Else" }),
    ];
    // Mirrors what CategoryFilterBar does: derive the chip from brandOptions,
    // then filter on the qid it reports.
    const [chip] = brandOptions(results);
    expect(chip.qid).toBe("Q1127798");
    const ids = applyFacetFilters(results, { brand: [chip.qid] }).map((p) => p.id);
    expect(ids).toEqual(["qpark"]);
  });

  it("keeps a place whose brand chip was derived from network:wikidata (EV charging)", () => {
    const results = [
      place("ionity", { "network:wikidata": "Q42717773", operator: "Ionity" }),
      place("other", { "network:wikidata": "Q1", operator: "Other Network" }),
    ];
    const ids = applyFacetFilters(results, { brand: ["Q42717773"] }).map((p) => p.id);
    expect(ids).toEqual(["ionity"]);
  });
});

describe("facetsForCategory", () => {
  it("offers food facets for restaurants but not for pharmacies", () => {
    const restaurant = facetsForCategory("restaurants").map((f) => f.id);
    expect(restaurant).toContain("wheelchairAccessible");
    expect(restaurant).toContain("cuisine");
    expect(restaurant).toContain("outdoorSeating");

    const pharmacy = facetsForCategory("pharmacies").map((f) => f.id);
    expect(pharmacy).toContain("wheelchairAccessible");
    expect(pharmacy).not.toContain("cuisine");
    expect(pharmacy).not.toContain("outdoorSeating");
  });

  it("returns nothing for an unknown/empty category", () => {
    expect(facetsForCategory(null)).toEqual([]);
  });
});

describe("cuisineOptions", () => {
  it("collects distinct, sorted cuisine values across results", () => {
    const results = [
      place("a", { cuisine: "italian;pizza" }),
      place("b", { cuisine: "italian" }),
      place("c", { cuisine: "burger" }),
      place("d"),
    ];
    expect(cuisineOptions(results)).toEqual(["burger", "italian", "pizza"]);
  });
});

describe("brandOptions", () => {
  it("counts a place tagged only with brand:wikidata", () => {
    const results = [
      place("a", { "brand:wikidata": "Q37158", brand: "Starbucks" }),
      place("b", { "brand:wikidata": "Q37158", brand: "Starbucks" }),
    ];
    expect(brandOptions(results)).toEqual([{ qid: "Q37158", name: "Starbucks", count: 2 }]);
  });

  it("counts a place tagged only with network:wikidata (e.g. an EV charging network)", () => {
    const results = [place("a", { "network:wikidata": "Q42717773", operator: "Ionity" })];
    expect(brandOptions(results)).toEqual([{ qid: "Q42717773", name: "Ionity", count: 1 }]);
  });

  it("counts a place tagged only with operator:wikidata", () => {
    const results = [place("a", { "operator:wikidata": "Q1127798", operator: "Q-Park" })];
    expect(brandOptions(results)).toEqual([{ qid: "Q1127798", name: "Q-Park", count: 1 }]);
  });

  it("prefers brand:wikidata over network:wikidata and operator:wikidata", () => {
    const results = [
      place("a", {
        "brand:wikidata": "Q37158",
        "network:wikidata": "Q42717773",
        "operator:wikidata": "Q1127798",
      }),
    ];
    expect(brandOptions(results)).toEqual([{ qid: "Q37158", name: "Q37158", count: 1 }]);
  });

  it("falls back from brand to operator, then the bare QID, for the display name", () => {
    expect(
      brandOptions([place("a", { "network:wikidata": "Q42717773", operator: "Ionity" })]),
    ).toEqual([{ qid: "Q42717773", name: "Ionity", count: 1 }]);
    expect(brandOptions([place("b", { "network:wikidata": "Q42717773" })])).toEqual([
      { qid: "Q42717773", name: "Q42717773", count: 1 },
    ]);
  });

  it("ignores a malformed QID", () => {
    expect(brandOptions([place("a", { "brand:wikidata": "not-a-qid" })])).toEqual([]);
  });

  it("returns nothing when no result carries a brand identity", () => {
    expect(brandOptions([place("a", { amenity: "fuel" }), place("b")])).toEqual([]);
  });
});
