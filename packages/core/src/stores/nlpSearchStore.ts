import { HOURS_FILTER_CATEGORY_IDS } from "@integrations/poi-search/types";
import { create } from "zustand";
import type { BoundingBox } from "../types/geometry";
import type { SearchIntent } from "../types/search";
import { CATEGORY_FACETS } from "../utils/categoryFacets";
import { useCategoryFacetStore } from "./categoryFacetStore";
import { useOpeningHoursStore } from "./openingHoursStore";

const DAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

interface NlpSearchState {
  intent: SearchIntent | null;
  resolvedBbox: BoundingBox | null;
  provider: string | null;
  isNlpActive: boolean;
  error: string | null;
  activate: (intent: SearchIntent, bbox: BoundingBox | null, provider: string | null) => void;
  setError: (error: string) => void;
  clear: () => void;
}

function applyTimeConstraint(intent: SearchIntent): void {
  const tc = intent.time_constraint;
  if (!tc) return;
  // Only categories that support an opening-hours filter can be narrowed by
  // time. Without this, a hallucinated "open_now" silently filters away every
  // result for categories that carry no opening_hours (e.g. schools).
  const activeCategory = intent.categories[0];
  if (!activeCategory || !HOURS_FILTER_CATEGORY_IDS.has(activeCategory)) return;
  const oh = useOpeningHoursStore.getState();
  if (tc.type === "open_now") {
    oh.setOpeningHoursFilter("open_now");
  } else if (tc.type === "open_24h") {
    oh.setOpeningHoursFilter("open_24h");
  } else if (tc.type === "open_at") {
    const dayIndex = DAY_INDEX[tc.day] ?? null;
    const hour = parseInt(tc.time.split(":")[0], 10);
    oh.setOpenAtFilter(dayIndex, Number.isNaN(hour) ? null : hour);
  }
}

function applyFacets(intent: SearchIntent): void {
  const facets = useCategoryFacetStore.getState();
  const attrs = intent.attributes;
  // Only apply facets that actually belong to the category being searched.
  // Models (especially small local ones) can emit attributes the user never
  // asked for; without this scope a hallucinated food/dietary attribute would
  // get applied to e.g. a "schools" search and filter every result away.
  const activeCategory = intent.categories[0];
  if (!activeCategory) return;
  for (const facet of CATEGORY_FACETS) {
    if (!facet.categoryIds.has(activeCategory)) continue;
    const value = attrs[facet.tag];
    if (value === undefined) continue;
    if (facet.type === "toggle") {
      if ((facet.matchValues ?? []).includes(value)) {
        facets.setMultiFacet(facet.id, ["on"]);
      }
    } else if (value !== "no") {
      // Multi facets (e.g. cuisine) take the value verbatim — skip the model's
      // default "no", which would filter to a nonexistent value (zero results).
      facets.setMultiFacet(facet.id, [value]);
    }
  }
}

export const useNlpSearchStore = create<NlpSearchState>((set) => ({
  intent: null,
  resolvedBbox: null,
  provider: null,
  isNlpActive: false,
  error: null,

  activate(intent, bbox, provider) {
    set({ intent, resolvedBbox: bbox, provider, isNlpActive: true, error: null });
    applyTimeConstraint(intent);
    applyFacets(intent);
  },

  setError(error) {
    set({ error });
  },

  clear() {
    useOpeningHoursStore.getState().reset();
    useCategoryFacetStore.getState().reset();
    set({ intent: null, resolvedBbox: null, provider: null, isNlpActive: false, error: null });
  },
}));
