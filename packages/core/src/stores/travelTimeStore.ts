import { create } from "zustand";
import type { LngLat } from "../types/geometry";
import type { IsochroneTravelMode } from "../types/isochrone";

const MAX_SELECTED = 4;

export const TRAVEL_TIME_PRESETS: Record<IsochroneTravelMode, number[]> = {
  walking: [5, 10, 15, 20, 30, 60],
  cycling: [5, 10, 15, 20, 30, 45, 60, 90],
  driving: [5, 10, 15, 30, 45, 60],
};

export interface TravelTimeState {
  isActive: boolean;
  origin: LngLat | null;
  mode: IsochroneTravelMode;
  selectedMinutes: number[];

  activate: () => void;
  deactivate: () => void;
  setOrigin: (lngLat: LngLat | null) => void;
  setMode: (mode: IsochroneTravelMode) => void;
  toggleMinutes: (minutes: number) => void;
}

export const useTravelTimeStore = create<TravelTimeState>((set) => ({
  isActive: false,
  origin: null,
  mode: "driving",
  selectedMinutes: [15],

  activate: () => set({ isActive: true, origin: null, selectedMinutes: [15] }),

  deactivate: () => set({ isActive: false, origin: null, selectedMinutes: [] }),

  setOrigin: (origin) => set({ origin }),

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
