import { createOverlayStore } from "@openmapx/core";

const ALL_CATEGORIES = [
  "volcanoes",
  "severeStorms",
  "floods",
  "landslides",
  "snow",
  "tempExtremes",
  "dustHaze",
  "seaLakeIce",
  "waterColor",
  "drought",
  "manmade",
] as const;

export type NaturalEventCategory = (typeof ALL_CATEGORIES)[number];
export { ALL_CATEGORIES };

export const useNaturalEventStore = createOverlayStore({
  overlayId: "natural-events",
  extra: {
    loading: false,
    days: null as number | null,
    activeCategories: new Set<string>(ALL_CATEGORIES) as Set<string>,
    eventCount: 0,
    lastUpdated: null as number | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setDays: (days: number | null) => set({ days }),
    toggleCategory: (id: string) =>
      set((state) => {
        const next = new Set(state.activeCategories);
        if (next.has(id)) {
          if (next.size > 1) next.delete(id);
        } else {
          next.add(id);
        }
        return { activeCategories: next };
      }),
    setEventCount: (eventCount: number) => set({ eventCount }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
  }),
  onClose: () => ({ eventCount: 0 }),
});
