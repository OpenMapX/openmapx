import type { CategoryPlace } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { brandImageId, distinctBrandQids } from "../CategoryResultMarkers";

function place(id: string, osmTags?: Record<string, string>): CategoryPlace {
  return { id, name: id, coordinates: [0, 0], osmTags } as CategoryPlace;
}

describe("distinctBrandQids", () => {
  it("collects each brand QID once", () => {
    expect(
      distinctBrandQids([
        place("a", { "brand:wikidata": "Q1" }),
        place("b", { "brand:wikidata": "Q1" }),
        place("c", { "brand:wikidata": "Q2" }),
      ]),
    ).toEqual(["Q1", "Q2"]);
  });

  it("reads operator and network QIDs too", () => {
    expect(
      distinctBrandQids([
        place("a", { "operator:wikidata": "Q3" }),
        place("b", { "network:wikidata": "Q4" }),
      ]),
    ).toEqual(["Q3", "Q4"]);
  });

  it("prefers the brand QID when a place carries more than one", () => {
    expect(
      distinctBrandQids([place("a", { "brand:wikidata": "Q1", "operator:wikidata": "Q9" })]),
    ).toEqual(["Q1"]);
  });

  it("ignores places with no brand identity", () => {
    expect(distinctBrandQids([place("a"), place("b", { amenity: "cafe" })])).toEqual([]);
  });

  it("rejects values that are not QIDs", () => {
    expect(distinctBrandQids([place("a", { "brand:wikidata": "not-a-qid" })])).toEqual([]);
  });
});

describe("brandImageId", () => {
  it("namespaces the id so it cannot collide with a category image", () => {
    expect(brandImageId("Q1")).toBe("brand-marker-Q1");
  });
});
