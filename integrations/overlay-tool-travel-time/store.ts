import type { IsochroneTravelMode, LngLat } from "@openmapx/core";
import { create } from "zustand";

const MAX_SELECTED = 4;

/**
 * Travel-time modes. `walking`/`cycling`/`driving` render Valhalla isochrone
 * polygons; `transit` renders an estimated continuous field derived from a
 * MOTIS one-to-all query. Reachable-stop dots remain an optional diagnostic.
 */
export type TravelTimeMode = IsochroneTravelMode | "transit";

export type TravelTimeBackend =
  | { kind: "street-isochrone"; mode: IsochroneTravelMode }
  | { kind: "transit-reachability" };

export function resolveTravelTimeBackend(mode: TravelTimeMode): TravelTimeBackend {
  return mode === "transit" ? { kind: "transit-reachability" } : { kind: "street-isochrone", mode };
}

export type TransitReachFilterState = "off" | "pending" | "applied" | "unavailable" | "failed";

export const TRAVEL_TIME_PRESETS: Record<TravelTimeMode, number[]> = {
  walking: [5, 10, 15, 20, 30, 60],
  cycling: [5, 10, 15, 20, 30, 45, 60, 90],
  driving: [5, 10, 15, 30, 45, 60],
  transit: [15, 30, 45, 60, 90],
};

export interface TravelTimeState {
  isActive: boolean;
  origin: LngLat | null;
  mode: TravelTimeMode;
  selectedMinutes: number[];
  /** Anchored mode (e.g. Explore): origin is seeded to a place, so the layer
   * skips click-to-place and the toolbar shows the "only within reach" filter. */
  anchored: boolean;
  /** Only meaningful in anchored mode — soft-filters consumer results to the contour. */
  onlyWithinReach: boolean;
  /** Stable, minute-normalized departure instant shared by surface and exact checks. */
  queryTime: string | null;
  showTransitStops: boolean;
  transitFieldUnsupported: "webgl2" | "float-render-target" | "shader" | null;
  transitFilterState: TransitReachFilterState;

  activate: () => void;
  activateAnchored: (origin: LngLat) => void;
  deactivate: () => void;
  setOrigin: (lngLat: LngLat | null) => void;
  setMode: (mode: TravelTimeMode) => void;
  toggleMinutes: (minutes: number) => void;
  setAnchored: (anchored: boolean) => void;
  setOnlyWithinReach: (onlyWithinReach: boolean) => void;
  setQueryTime: (time?: string | Date) => void;
  setShowTransitStops: (show: boolean) => void;
  setTransitFieldUnsupported: (reason: "webgl2" | "float-render-target" | "shader" | null) => void;
  setTransitFilterState: (state: TransitReachFilterState) => void;
}

export function normalizedDepartureMinute(time: string | Date | number = Date.now()): string {
  const date = time instanceof Date ? new Date(time) : new Date(time);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid reachability time");
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export const useTravelTimeStore = create<TravelTimeState>((set) => ({
  isActive: false,
  origin: null,
  mode: "driving",
  selectedMinutes: [15],
  anchored: false,
  onlyWithinReach: false,
  queryTime: null,
  showTransitStops: false,
  transitFieldUnsupported: null,
  transitFilterState: "off",

  activate: () =>
    set({
      isActive: true,
      origin: null,
      selectedMinutes: [15],
      anchored: false,
      onlyWithinReach: false,
      queryTime: normalizedDepartureMinute(),
      transitFieldUnsupported: null,
      transitFilterState: "off",
    }),

  activateAnchored: (origin) =>
    set({
      isActive: true,
      origin,
      selectedMinutes: [15],
      anchored: true,
      onlyWithinReach: false,
      queryTime: normalizedDepartureMinute(),
      transitFieldUnsupported: null,
      transitFilterState: "off",
    }),

  deactivate: () =>
    set({
      isActive: false,
      origin: null,
      selectedMinutes: [],
      anchored: false,
      onlyWithinReach: false,
      queryTime: null,
      transitFieldUnsupported: null,
      transitFilterState: "off",
    }),

  setOrigin: (origin) =>
    set((state) => ({
      origin,
      ...(state.isActive && state.mode === "transit"
        ? { queryTime: normalizedDepartureMinute() }
        : {}),
    })),

  setAnchored: (anchored) => set({ anchored }),

  setOnlyWithinReach: (onlyWithinReach) =>
    set({ onlyWithinReach, transitFilterState: onlyWithinReach ? "pending" : "off" }),
  setQueryTime: (time) => set({ queryTime: normalizedDepartureMinute(time ?? Date.now()) }),
  setShowTransitStops: (showTransitStops) => set({ showTransitStops }),
  setTransitFieldUnsupported: (transitFieldUnsupported) => set({ transitFieldUnsupported }),
  setTransitFilterState: (transitFilterState) => set({ transitFilterState }),

  setMode: (mode) =>
    set((s) => {
      const presets = TRAVEL_TIME_PRESETS[mode];
      const stillValid = s.selectedMinutes.filter((m) => presets.includes(m));
      return {
        mode,
        selectedMinutes: stillValid.length > 0 ? stillValid : [presets[2] ?? presets[0]],
        transitFilterState:
          mode === "transit" && s.anchored && s.onlyWithinReach ? "pending" : "off",
        ...(mode === "transit" && s.mode !== "transit"
          ? { queryTime: normalizedDepartureMinute() }
          : {}),
      };
    }),

  toggleMinutes: (minutes) =>
    set((s) => {
      const idx = s.selectedMinutes.indexOf(minutes);
      if (idx >= 0) {
        const next = s.selectedMinutes.filter((_, i) => i !== idx);
        return { selectedMinutes: next.length > 0 ? next : s.selectedMinutes };
      }
      if (s.selectedMinutes.length >= MAX_SELECTED) {
        return { selectedMinutes: [...s.selectedMinutes.slice(1), minutes] };
      }
      return { selectedMinutes: [...s.selectedMinutes, minutes] };
    }),
}));
