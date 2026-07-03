import { describe, expect, it } from "vitest";
import type { CategoryPlace } from "../types/category";
import { applyFacetFilters, cuisineOptions, facetsForCategory } from "./categoryFacets";

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
