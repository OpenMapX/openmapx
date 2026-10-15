import { createOverlayStore } from "@openmapx/core";

/** Severity threshold options for the legend filter (`"all"` = no threshold). */
export type MinSeverity = "all" | "minor" | "moderate" | "major" | "critical";

/**
 * Time-horizon steps for the legend filter: what is in effect now, what starts
 * within the week (trip planning), or everything the feeds announce — which for
 * planned-works sources reaches months out.
 */
export type Horizon = "active" | "week" | "all";

export type RoadConditionFetchStatus = "idle" | "loading" | "ready" | "stale" | "error";

/** How a road data source drawn by the overlay stands for the current view. */
export interface RoadSourceStatus {
  state: "idle" | "loading" | "ready" | "error";
  count: number;
}

/** The `horizonDays` query value for a step; `"all"` omits the param entirely. */
export function horizonDaysParam(horizon: Horizon): string | undefined {
  if (horizon === "active") return "0";
  if (horizon === "week") return "7";
  return undefined;
}

/**
 * Overlay store for the road-conditions layer. Beyond the shared
 * `layerVisible`/`panelOpen` flags, it holds the legend's filter state — the
 * registry kinds the user hid (none by default, so every kind shows), a
 * minimum-severity threshold, and a time horizon. All three are forwarded to
 * the `/events` query, so filtering happens server-side across every
 * road-conditions provider (the route accepts
 * `excludeKinds`/`minSeverity`/`horizonDays`), not just client-side hiding.
 *
 * It also holds which layers the overlay draws: the incidents (on by default)
 * and any of the road data sources (message signs, road weather, maintenance
 * vehicles, border crossings), which start off so a busy region does not fill
 * with markers nobody asked for, plus how each shown source stands.
 *
 * The horizon defaults to `"active"`: planned-works feeds announce months of
 * future closures, and showing them by default buries what is actually in the
 * user's way right now.
 */
export const useRoadConditionsStore = createOverlayStore({
  overlayId: "road-conditions",
  extra: {
    hiddenKinds: [] as string[],
    minSeverity: "all" as MinSeverity,
    horizon: "active" as Horizon,
    viewportFetchStatus: "idle" as RoadConditionFetchStatus,
    routeFetchStatus: "idle" as RoadConditionFetchStatus,
    showIncidents: true,
    shownSources: [] as string[],
    sourceStatus: {} as Record<string, RoadSourceStatus>,
  },
  actions: (set) => ({
    toggleKind: (kind: string) =>
      set((s) => ({
        hiddenKinds: s.hiddenKinds.includes(kind)
          ? s.hiddenKinds.filter((k) => k !== kind)
          : [...s.hiddenKinds, kind],
      })),
    setMinSeverity: (minSeverity: MinSeverity) => set({ minSeverity }),
    setHorizon: (horizon: Horizon) => set({ horizon }),
    setViewportFetchStatus: (viewportFetchStatus: RoadConditionFetchStatus) =>
      set({ viewportFetchStatus }),
    setRouteFetchStatus: (routeFetchStatus: RoadConditionFetchStatus) => set({ routeFetchStatus }),
    toggleIncidents: () => set((s) => ({ showIncidents: !s.showIncidents })),
    toggleSource: (id: string) =>
      set((s) => ({
        shownSources: s.shownSources.includes(id)
          ? s.shownSources.filter((shown) => shown !== id)
          : [...s.shownSources, id],
      })),
    setSourceStatus: (id: string, status: RoadSourceStatus | null) =>
      set((s) => {
        const { [id]: _previous, ...rest } = s.sourceStatus;
        return { sourceStatus: status ? { ...rest, [id]: status } : rest };
      }),
    resetFilters: () => set({ hiddenKinds: [], minSeverity: "all", horizon: "active" }),
  }),
});
