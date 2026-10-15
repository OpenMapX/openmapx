import { createOverlayStore, getStorage } from "@openmapx/core";
import { ROAD_SOURCE_IDS } from "./road-sources";

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

const MIN_SEVERITIES: readonly MinSeverity[] = ["all", "minor", "moderate", "major", "critical"];
const HORIZONS: readonly Horizon[] = ["active", "week", "all"];

/** Where the reader's layer and filter choices are kept between visits. */
export const ROAD_CONDITIONS_STORAGE_KEY = "openmapx:roadConditions";

/** The choices the legend remembers: which layers it draws and how incidents are filtered. */
export interface RoadConditionsChoices {
  showIncidents: boolean;
  shownSources: string[];
  hiddenKinds: string[];
  minSeverity: MinSeverity;
  horizon: Horizon;
}

const DEFAULT_CHOICES: RoadConditionsChoices = {
  showIncidents: true,
  shownSources: [],
  hiddenKinds: [],
  minSeverity: "all",
  horizon: "active",
};

/**
 * Read the remembered choices, keeping only values this version understands,
 * so a stale or hand-edited entry falls back field by field to the defaults.
 */
export function loadRoadConditionsChoices(): RoadConditionsChoices {
  let saved: Partial<Record<keyof RoadConditionsChoices, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(getStorage().getString(ROAD_CONDITIONS_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // Unreadable entries fall back to the defaults.
  }
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
  const sources = strings(saved.shownSources);
  const kinds = strings(saved.hiddenKinds);
  return {
    showIncidents:
      typeof saved.showIncidents === "boolean"
        ? saved.showIncidents
        : DEFAULT_CHOICES.showIncidents,
    shownSources: sources
      ? ROAD_SOURCE_IDS.filter((id) => sources.includes(id))
      : DEFAULT_CHOICES.shownSources,
    hiddenKinds: kinds ? [...new Set(kinds)].slice(0, 32) : DEFAULT_CHOICES.hiddenKinds,
    minSeverity: MIN_SEVERITIES.includes(saved.minSeverity as MinSeverity)
      ? (saved.minSeverity as MinSeverity)
      : DEFAULT_CHOICES.minSeverity,
    horizon: HORIZONS.includes(saved.horizon as Horizon)
      ? (saved.horizon as Horizon)
      : DEFAULT_CHOICES.horizon,
  };
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
 * Those layer and filter choices are remembered on this device, so someone
 * who keeps road weather on finds it on next time.
 *
 * The horizon defaults to `"active"`: planned-works feeds announce months of
 * future closures, and showing them by default buries what is actually in the
 * user's way right now.
 */
export const useRoadConditionsStore = createOverlayStore({
  overlayId: "road-conditions",
  extra: {
    ...DEFAULT_CHOICES,
    viewportFetchStatus: "idle" as RoadConditionFetchStatus,
    routeFetchStatus: "idle" as RoadConditionFetchStatus,
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

function choicesOf(state: RoadConditionsChoices): string {
  const { showIncidents, shownSources, hiddenKinds, minSeverity, horizon } = state;
  return JSON.stringify({ showIncidents, shownSources, hiddenKinds, minSeverity, horizon });
}

let restored = false;

/**
 * Apply the remembered choices once, then keep them saved as they change.
 * This waits for the first road-conditions component to mount rather than
 * running when the module loads, as the app may not have connected its
 * storage by then.
 */
export function restoreRoadConditionsChoices(): void {
  if (restored) return;
  restored = true;
  useRoadConditionsStore.setState(loadRoadConditionsChoices());
  let saved = choicesOf(useRoadConditionsStore.getState());
  useRoadConditionsStore.subscribe((state) => {
    const next = choicesOf(state);
    if (next === saved) return;
    saved = next;
    getStorage().setString(ROAD_CONDITIONS_STORAGE_KEY, next);
  });
}
