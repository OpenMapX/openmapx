import { create } from "zustand";

const TOGGLE_ON = ["on"];

interface CategoryFacetState {
  /** facetId → selected values. Toggle facets store `["on"]` when active; multi
   *  facets store the selected option values. Absent/empty means inactive. */
  selections: Record<string, string[]>;
  /** Flip a boolean (toggle) facet on/off. */
  toggleFacet: (facetId: string) => void;
  /** Set the selected values of a multi facet (empty array clears it). */
  setMultiFacet: (facetId: string, values: string[]) => void;
  /** Clear a set of facets (e.g. just the panel facets on "Clear"). */
  clearFacets: (facetIds: string[]) => void;
  reset: () => void;
}

export const useCategoryFacetStore = create<CategoryFacetState>((set) => ({
  selections: {},
  toggleFacet: (facetId) =>
    set((state) => {
      const next = { ...state.selections };
      if ((next[facetId]?.length ?? 0) > 0) delete next[facetId];
      else next[facetId] = TOGGLE_ON;
      return { selections: next };
    }),
  setMultiFacet: (facetId, values) =>
    set((state) => {
      const next = { ...state.selections };
      if (values.length === 0) delete next[facetId];
      else next[facetId] = values;
      return { selections: next };
    }),
  clearFacets: (facetIds) =>
    set((state) => {
      const next = { ...state.selections };
      for (const id of facetIds) delete next[id];
      return { selections: next };
    }),
  reset: () => set({ selections: {} }),
}));
