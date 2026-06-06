import type { IsochroneTravelMode, LngLat } from "@openmapx/core";
import { create } from "zustand";

const MAX_SELECTED = 4;

/**
 * Travel-time modes. `walking`/`cycling`/`driving` render Valhalla isochrone
 * polygons; `transit` renders a MOTIS one-to-all reachability layer (graduated
 * stop dots) since transit reachability is point-based, not a single contour.
 */
export type TravelTimeMode = IsochroneTravelMode | "transit";

/**
 * Resolve a travel-time mode for the isochrone request. Valhalla isochrones
 * can't route transit, so `transit` substitutes a street mode (walking) and is
 * flagged so callers disable the isochrone request and let the point-based
 * reachability layer take over. One source of truth for the toolbar, the map
 * layer, and the within-reach filter, so the substitution can't drift between
 * them.
 */
export function resolveIsochroneMode(mode: TravelTimeMode): {
  isTransit: boolean;
  isochroneMode: IsochroneTravelMode;
} {
  const isTransit = mode === "transit";
  const isochroneMode: IsochroneTravelMode = isTransit ? "walking" : mode;
  return { isTransit, isochroneMode };
}

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

  activate: () => void;
  activateAnchored: (origin: LngLat) => void;
  deactivate: () => void;
  setOrigin: (lngLat: LngLat | null) => void;
  setMode: (mode: TravelTimeMode) => void;
  toggleMinutes: (minutes: number) => void;
  setAnchored: (anchored: boolean) => void;
  setOnlyWithinReach: (onlyWithinReach: boolean) => void;
}

export const useTravelTimeStore = create<TravelTimeState>((set) => ({
  isActive: false,
  origin: null,
  mode: "driving",
  selectedMinutes: [15],
  anchored: false,
  onlyWithinReach: false,

  activate: () =>
    set({
      isActive: true,
      origin: null,
      selectedMinutes: [15],
      anchored: false,
      onlyWithinReach: false,
    }),

  activateAnchored: (origin) =>
    set({ isActive: true, origin, selectedMinutes: [15], anchored: true, onlyWithinReach: false }),

  deactivate: () =>
    set({
      isActive: false,
      origin: null,
      selectedMinutes: [],
      anchored: false,
      onlyWithinReach: false,
    }),

  setOrigin: (origin) => set({ origin }),

  setAnchored: (anchored) => set({ anchored }),

  setOnlyWithinReach: (onlyWithinReach) => set({ onlyWithinReach }),

  setMode: (mode) =>
    set((s) => {
      const presets = TRAVEL_TIME_PRESETS[mode];
      const stillValid = s.selectedMinutes.filter((m) => presets.includes(m));
      return {
        mode,
        selectedMinutes: stillValid.length > 0 ? stillValid : [presets[2] ?? presets[0]],
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
