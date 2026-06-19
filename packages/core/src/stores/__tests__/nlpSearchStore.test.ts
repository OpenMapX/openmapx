import { beforeEach, describe, expect, it } from "vitest";
import type { BoundingBox } from "../../types/geometry";
import type { SearchIntent } from "../../types/search";
import type { OverpassFilter } from "../../utils/overpassFilter";
import { useCategoryFacetStore } from "../categoryFacetStore";
import { AD_HOC_CATEGORY_ID, useCategorySearchStore } from "../categorySearchStore";
import { useNlpSearchStore } from "../nlpSearchStore";
import { useOpeningHoursStore } from "../openingHoursStore";

const bbox: BoundingBox = { west: 13.0, south: 52.0, east: 14.0, north: 53.0 };

function makeFilter(overrides?: Partial<OverpassFilter>): OverpassFilter {
  return {
    selectors: [{ tags: [{ key: "amenity", op: "=", value: "restaurant" }] }],
    ...overrides,
  };
}

function makeIntent(overrides?: Partial<SearchIntent>): SearchIntent {
  return {
    filter: makeFilter(),
    spatial_constraint: null,
    time_constraint: null,
    sort_by: "relevance",
    unmapped_attributes: [],
    confidence: 0.9,
    explanation: "test",
    ...overrides,
  };
}

describe("useNlpSearchStore", () => {
  beforeEach(() => {
    useNlpSearchStore.getState().clear();
    useCategorySearchStore.getState().clearCategory();
    useOpeningHoursStore.getState().reset();
    useCategoryFacetStore.getState().reset();
  });

  describe("activate", () => {
    it("stores intent, bbox, provider and sets isNlpActive true", () => {
      const intent = makeIntent();
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      const s = useNlpSearchStore.getState();
      expect(s.isNlpActive).toBe(true);
      expect(s.intent).toBe(intent);
      expect(s.resolvedBbox).toBe(bbox);
      expect(s.provider).toBe("openai");
      expect(s.error).toBeNull();
    });

    it("stores intent.filter", () => {
      const filter = makeFilter({
        selectors: [
          { tags: [{ key: "amenity", op: "=", value: "cafe" }] },
          { tags: [{ key: "amenity", op: "=", value: "restaurant" }] },
        ],
      });
      const intent = makeIntent({ filter });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      expect(useNlpSearchStore.getState().intent?.filter).toBe(filter);
    });

    describe("time_constraint population", () => {
      it("open_now → setOpeningHoursFilter('open_now')", () => {
        const intent = makeIntent({ time_constraint: { type: "open_now" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("open_now");
      });

      it("open_24h → setOpeningHoursFilter('open_24h')", () => {
        const intent = makeIntent({ time_constraint: { type: "open_24h" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("open_24h");
      });

      it("open_at Monday 22:00 → openingHoursFilter 'open_at', openAtDay 1, openAtHour 22", () => {
        const intent = makeIntent({
          time_constraint: { type: "open_at", day: "Monday", time: "22:00" },
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        const oh = useOpeningHoursStore.getState();
        expect(oh.openingHoursFilter).toBe("open_at");
        expect(oh.openAtDay).toBe(1);
        expect(oh.openAtHour).toBe(22);
      });

      it("open_at Sunday 09:30 → openAtDay 0, openAtHour 9", () => {
        const intent = makeIntent({
          time_constraint: { type: "open_at", day: "Sunday", time: "09:30" },
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        const oh = useOpeningHoursStore.getState();
        expect(oh.openingHoursFilter).toBe("open_at");
        expect(oh.openAtDay).toBe(0);
        expect(oh.openAtHour).toBe(9);
      });

      it("open_at Saturday → openAtDay 6", () => {
        const intent = makeIntent({
          time_constraint: { type: "open_at", day: "Saturday", time: "10:00" },
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useOpeningHoursStore.getState().openAtDay).toBe(6);
      });

      it("no time_constraint → opening hours filter stays 'any'", () => {
        const intent = makeIntent({ time_constraint: null });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("any");
      });

      it("applies time_constraint regardless of which selectors are present (no category gating)", () => {
        // In ad-hoc filter mode, the model is trusted to only emit time_constraint
        // when the user explicitly mentions time — we don't gate on category id.
        const intent = makeIntent({
          filter: makeFilter({
            selectors: [{ tags: [{ key: "amenity", op: "=", value: "school" }] }],
          }),
          time_constraint: { type: "open_now" },
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("open_now");
      });
    });

    describe("facet population from filter.require", () => {
      it("require [{key:'outdoor_seating',op:'=',value:'yes'}] → outdoorSeating facet activated", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "outdoor_seating", op: "=", value: "yes" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.outdoorSeating).toEqual(["on"]);
      });

      it("require [{key:'wheelchair',op:'=',value:'yes'}] → wheelchairAccessible toggle facet activated", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "wheelchair", op: "=", value: "yes" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.wheelchairAccessible).toEqual(["on"]);
      });

      it("require [{key:'diet:vegan',op:'=',value:'yes'}] → vegan toggle facet activated", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "diet:vegan", op: "=", value: "yes" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.vegan).toEqual(["on"]);
      });

      it("require [{key:'cuisine',op:'~',value:'italian'}] → cuisine multi facet set to ['italian']", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "cuisine", op: "~", value: "italian" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.cuisine).toEqual(["italian"]);
      });

      it("require with unknown key → no facet applied, no crash", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "unknown_key", op: "=", value: "foo" }],
          }),
        });
        expect(() => useNlpSearchStore.getState().activate(intent, bbox, "openai")).not.toThrow();
        expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
      });

      it("require [{key:'wheelchair',op:'=',value:'no'}] → toggle not activated (value not in matchValues)", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "wheelchair", op: "=", value: "no" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.wheelchairAccessible).toBeUndefined();
      });

      it("no require predicates → no facets applied", () => {
        const intent = makeIntent({
          filter: makeFilter({ require: undefined }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
      });

      it("require with wheelchair=limited → wheelchairAccessible toggle activated (limited is a matchValue)", () => {
        const intent = makeIntent({
          filter: makeFilter({
            require: [{ key: "wheelchair", op: "=", value: "limited" }],
          }),
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.wheelchairAccessible).toEqual(["on"]);
      });
    });
  });

  describe("setError", () => {
    it("stores an error message and does not clear intent", () => {
      const intent = makeIntent();
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      useNlpSearchStore.getState().setError("NLP service unavailable");
      const s = useNlpSearchStore.getState();
      expect(s.error).toBe("NLP service unavailable");
      expect(s.intent).toBe(intent);
    });
  });

  describe("clear", () => {
    it("resets own state", () => {
      const intent = makeIntent({ time_constraint: { type: "open_now" } });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      useNlpSearchStore.getState().clear();
      const s = useNlpSearchStore.getState();
      expect(s.isNlpActive).toBe(false);
      expect(s.intent).toBeNull();
      expect(s.resolvedBbox).toBeNull();
      expect(s.provider).toBeNull();
      expect(s.error).toBeNull();
    });

    it("resets opening hours store to 'any'", () => {
      const intent = makeIntent({ time_constraint: { type: "open_now" } });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      useNlpSearchStore.getState().clear();
      expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("any");
    });

    it("resets facet store selections", () => {
      const intent = makeIntent({
        filter: makeFilter({ require: [{ key: "wheelchair", op: "=", value: "yes" }] }),
      });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      useNlpSearchStore.getState().clear();
      expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
    });
  });
});

describe("activate→setAdHocFilter store seam", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
  });

  it("setAdHocFilter stores the filter and sets activeCategory to AD_HOC_CATEGORY_ID", () => {
    const filter = makeFilter({
      selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
    });
    useCategorySearchStore.getState().setAdHocFilter(filter, "Cafes near me");
    const s = useCategorySearchStore.getState();
    expect(s.adHocFilter).toBe(filter);
    expect(s.adHocLabel).toBe("Cafes near me");
    expect(s.activeCategory).toBe(AD_HOC_CATEGORY_ID);
  });
});
