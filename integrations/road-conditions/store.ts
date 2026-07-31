import { createOverlayStore } from "@openmapx/core";

/** Severity threshold options for the legend filter (`"all"` = no threshold). */
export type MinSeverity = "all" | "low" | "medium" | "high" | "critical";

/**
 * Time-horizon steps for the legend filter: what is in effect now, what starts
 * within the week (trip planning), or everything the feeds announce — which for
 * planned-works sources reaches months out.
 */
export type Horizon = "active" | "week" | "all";

/** The `horizonDays` query value for a step; `"all"` omits the param entirely. */
export function horizonDaysParam(horizon: Horizon): string | undefined {
  if (horizon === "active") return "0";
  if (horizon === "week") return "7";
  return undefined;
}

/**
 * Overlay store for the road-conditions layer. Beyond the shared
 * `layerVisible`/`panelOpen` flags, it holds the legend's filter state — a set
 * of `type` values to show (empty = all), a minimum-severity threshold, and a
 * time horizon. All three are forwarded to the `/events` query, so filtering
 * happens server-side across every road-conditions provider (the route accepts
 * `types`/`minSeverity`/`horizonDays`), not just client-side hiding.
 *
 * The horizon defaults to `"active"`: planned-works feeds announce months of
 * future closures, and showing them by default buries what is actually in the
 * user's way right now.
 */
export const useRoadConditionsStore = createOverlayStore({
  overlayId: "road-conditions",
  extra: {
    types: [] as string[],
    minSeverity: "all" as MinSeverity,
    horizon: "active" as Horizon,
  },
  actions: (set) => ({
    toggleType: (type: string) =>
      set((s) => ({
        types: s.types.includes(type) ? s.types.filter((t) => t !== type) : [...s.types, type],
      })),
    setMinSeverity: (minSeverity: MinSeverity) => set({ minSeverity }),
    setHorizon: (horizon: Horizon) => set({ horizon }),
    resetFilters: () => set({ types: [], minSeverity: "all", horizon: "active" }),
  }),
});
