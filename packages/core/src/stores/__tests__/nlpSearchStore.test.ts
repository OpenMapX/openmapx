import { beforeEach, describe, expect, it } from "vitest";
import type { BoundingBox } from "../../types/geometry";
import type { SearchIntent } from "../../types/search";
import { useCategoryFacetStore } from "../categoryFacetStore";
import { useNlpSearchStore } from "../nlpSearchStore";
import { useOpeningHoursStore } from "../openingHoursStore";

const bbox: BoundingBox = { west: 13.0, south: 52.0, east: 14.0, north: 53.0 };

function makeIntent(overrides?: Partial<SearchIntent>): SearchIntent {
  return {
    categories: ["restaurants"],
    attributes: {},
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

    it("stores intent.categories", () => {
      const intent = makeIntent({ categories: ["cafes", "restaurants"] });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      expect(useNlpSearchStore.getState().intent?.categories).toEqual(["cafes", "restaurants"]);
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
    });

    describe("facet population from attributes", () => {
      it("wheelchair=yes → wheelchairAccessible toggle facet activated", () => {
        const intent = makeIntent({ attributes: { wheelchair: "yes" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.wheelchairAccessible).toEqual(["on"]);
      });

      it("outdoor_seating=yes → outdoorSeating toggle facet activated", () => {
        const intent = makeIntent({ attributes: { outdoor_seating: "yes" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.outdoorSeating).toEqual(["on"]);
      });

      it("diet:vegan=yes → vegan toggle facet activated", () => {
        const intent = makeIntent({ attributes: { "diet:vegan": "yes" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.vegan).toEqual(["on"]);
      });

      it("cuisine=italian → cuisine multi facet set to ['italian']", () => {
        const intent = makeIntent({ attributes: { cuisine: "italian" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.cuisine).toEqual(["italian"]);
      });

      it("unknown attribute key → no facet applied, no crash", () => {
        const intent = makeIntent({ attributes: { unknown_key: "foo" } });
        expect(() => useNlpSearchStore.getState().activate(intent, bbox, "openai")).not.toThrow();
        expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
      });

      it("wheelchair=no → toggle not activated (value not in matchValues)", () => {
        const intent = makeIntent({ attributes: { wheelchair: "no" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.wheelchairAccessible).toBeUndefined();
      });

      it("ignores facets not scoped to the active category (e.g. food attrs on a schools search)", () => {
        // Reproduces the Aachen bug: a small model hallucinated a full attribute
        // set for "Schulen in meiner Nähe"; none of these apply to schools, so
        // no facet should be set and the schools results must not be filtered.
        const intent = makeIntent({
          categories: ["schools"],
          attributes: {
            outdoor_seating: "no",
            wheelchair: "limited",
            internet_access: "wlan",
            cuisine: "no",
            "diet:vegan": "yes",
          },
        });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
      });

      it("skips a multi facet whose value is the model default 'no'", () => {
        const intent = makeIntent({ categories: ["restaurants"], attributes: { cuisine: "no" } });
        useNlpSearchStore.getState().activate(intent, bbox, "openai");
        expect(useCategoryFacetStore.getState().selections.cuisine).toBeUndefined();
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
      const intent = makeIntent({ attributes: { wheelchair: "yes" } });
      useNlpSearchStore.getState().activate(intent, bbox, "openai");
      useNlpSearchStore.getState().clear();
      expect(Object.keys(useCategoryFacetStore.getState().selections)).toHaveLength(0);
    });
  });
});
