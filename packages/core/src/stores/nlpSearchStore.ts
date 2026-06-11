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
  for (const facet of CATEGORY_FACETS) {
    const value = attrs[facet.tag];
    if (value === undefined) continue;
    if (facet.type === "toggle") {
      if ((facet.matchValues ?? []).includes(value)) {
        facets.setMultiFacet(facet.id, ["on"]);
      }
    } else {
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
