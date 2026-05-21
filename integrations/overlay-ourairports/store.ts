import { createOverlayStore } from "@openmapx/core";

export type AirportTypeFilter = "all" | "scheduled" | "ifr" | "with_iata";

export const useAirportsOverlayStore = createOverlayStore({
  overlayId: "ourairports",
  extra: {
    loading: false,
    /**
     * Default filter. `scheduled` is the sweet spot for a global overlay —
     * shows commercial airports without flooding the map with thousands of
     * unmarked grass strips. The user can broaden via the legend.
     */
    filter: "scheduled" as AirportTypeFilter,
    lastUpdated: null as number | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setFilter: (filter: AirportTypeFilter) => set({ filter }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
  }),
});
