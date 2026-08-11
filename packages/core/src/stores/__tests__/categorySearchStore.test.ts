import { beforeEach, describe, expect, it } from "vitest";
import type { CategoryPlace } from "../../types/category";
import { applyFacetFilters } from "../../utils/categoryFacets";
import type { OverpassFilter } from "../../utils/overpassFilter";
import { useCategoryFacetStore } from "../categoryFacetStore";
import { AD_HOC_CATEGORY_ID, useCategorySearchStore } from "../categorySearchStore";
import { useOpeningHoursStore } from "../openingHoursStore";

const validFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
};

function place(id: string, osmTags?: Record<string, string>): CategoryPlace {
  return { id, name: id, coordinates: [0, 0], osmTags };
}

describe("useCategorySearchStore — ad-hoc filter", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
    useOpeningHoursStore.getState().reset();
    useCategoryFacetStore.getState().reset();
  });

  describe("AD_HOC_CATEGORY_ID constant", () => {
    it("equals 'nlp:filter'", () => {
      expect(AD_HOC_CATEGORY_ID).toBe("nlp:filter");
    });
  });

  describe("setAdHocFilter", () => {
    it("sets adHocFilter and adHocLabel", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes nearby");
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBe(validFilter);
      expect(s.adHocLabel).toBe("Cafes nearby");
    });

    it("sets activeCategory to AD_HOC_CATEGORY_ID", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      expect(useCategorySearchStore.getState().activeCategory).toBe(AD_HOC_CATEGORY_ID);
    });

    it("sets mode to 'category' and clears textQuery", () => {
      useCategorySearchStore.getState().setExploreText("some text");
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      const s = useCategorySearchStore.getState();
      expect(s.mode).toBe("category");
      expect(s.textQuery).toBe("");
    });
  });

  describe("setActiveCategory clears ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel when selecting a real category", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setActiveCategory("cafes" as never);
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });

    it("nulls ad-hoc state when called with null", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setActiveCategory(null);
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });
  });

  describe("setExploreText clears ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel when entering text search", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setExploreText("pizza near me");
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });
  });

  describe("clearCategory resets ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().clearCategory();
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });

    it("also resets activeCategory to null", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().clearCategory();
      expect(useCategorySearchStore.getState().activeCategory).toBeNull();
    });
  });
});

describe("useCategorySearchStore — brand facet lifecycle", () => {
  // Regression coverage for a stale `brand:wikidata` facet selection (written by
  // nlpSearchStore.applyFacets whenever an NLP query resolves a chain name)
  // silently surviving into the next, unrelated search. That selection has no
  // query scope of its own and no visible UI once it does — the brand chip row
  // only renders at 2+ brands, and the facet is `placement: "inline"` so it
  // never reaches the Filters panel badge — so before the fix a place that
  // does NOT belong to the stale chain would be silently dropped from later
  // results with no indication why.
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
    useOpeningHoursStore.getState().reset();
    useCategoryFacetStore.getState().reset();
  });

  it("a stale brand facet selection no longer narrows the results of the next text search", () => {
    // Simulates nlpSearchStore.applyFacets after an "aldi open now" query resolved.
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q41171373"]);

    // User starts an unrelated free-text search — the same transition
    // useTextSearchResults' underlying store observes.
    useCategorySearchStore.getState().setExploreText("pizza near me");

    const results = [
      place("aldi-branch", { "brand:wikidata": "Q41171373" }),
      place("pizzeria-luigi"), // no brand tag at all — must survive
    ];
    const selections = useCategoryFacetStore.getState().selections;
    const filtered = applyFacetFilters(results, selections);

    expect(filtered.map((p) => p.id)).toContain("pizzeria-luigi");
    expect(filtered).toHaveLength(2);
  });

  it("setExploreText clears the brand facet selection", () => {
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q1"]);
    useCategorySearchStore.getState().setExploreText("pizza");
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });

  it("setActiveCategory clears the brand facet selection", () => {
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q1"]);
    useCategorySearchStore.getState().setActiveCategory("cafes" as never);
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });

  it("setAdHocFilter clears the brand facet selection", () => {
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q1"]);
    useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });

  it("clearCategory clears the brand facet selection", () => {
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q1"]);
    useCategorySearchStore.getState().clearCategory();
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });

  it("does not clear unrelated facet selections (e.g. wheelchair) on a new text search", () => {
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q1"]);
    useCategoryFacetStore.getState().toggleFacet("wheelchairAccessible");
    useCategorySearchStore.getState().setExploreText("pizza");
    const selections = useCategoryFacetStore.getState().selections;
    expect(selections.brand).toBeUndefined();
    expect(selections.wheelchairAccessible).toEqual(["on"]);
  });
});
