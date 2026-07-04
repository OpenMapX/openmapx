import { createOverlayStore } from "@openmapx/core";

/** Severity threshold options for the legend filter (`"all"` = no threshold). */
export type MinSeverity = "all" | "low" | "medium" | "high" | "critical";

/**
 * Overlay store for the road-conditions layer. Beyond the shared
 * `layerVisible`/`panelOpen` flags, it holds the legend's filter state — a set
 * of `type` values to show (empty = all) and a minimum-severity threshold. Both
 * are forwarded to the `/events` query, so filtering happens server-side across
 * every road-conditions provider (the route already accepts `types`/
 * `minSeverity`), not just client-side hiding.
 */
export const useRoadConditionsStore = createOverlayStore({
  overlayId: "road-conditions",
  extra: {
    types: [] as string[],
    minSeverity: "all" as MinSeverity,
  },
  actions: (set) => ({
    toggleType: (type: string) =>
      set((s) => ({
        types: s.types.includes(type) ? s.types.filter((t) => t !== type) : [...s.types, type],
      })),
    setMinSeverity: (minSeverity: MinSeverity) => set({ minSeverity }),
    resetFilters: () => set({ types: [], minSeverity: "all" }),
  }),
});
