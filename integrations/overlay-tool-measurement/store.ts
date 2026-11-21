import { type LngLat, type UnitSystem, useSettingsStore } from "@openmapx/core";
import { create } from "zustand";

export type MeasurementMode = "line" | "polygon";
export type { UnitSystem };

/** The polygon ring through `points` back to the first one, or null below three points. */
export function closedRing(points: readonly LngLat[]): LngLat[] | null {
  const first = points[0];
  return first && points.length >= 3 ? [...points, first] : null;
}

export interface MeasurementState {
  isActive: boolean;
  mode: MeasurementMode;
  points: LngLat[];
  undonePoints: LngLat[];
  unitSystem: UnitSystem;
  isFinalized: boolean;

  activate: () => void;
  deactivate: () => void;
  setMode: (mode: MeasurementMode) => void;
  addPoint: (point: LngLat) => void;
  removePoint: (index: number) => void;
  movePoint: (index: number, lngLat: LngLat) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  finalize: () => void;
  setUnitSystem: (system: UnitSystem) => void;
}

export const useMeasurementStore = create<MeasurementState>((set, get) => ({
  isActive: false,
  mode: "line",
  points: [],
  undonePoints: [],
  unitSystem: "metric",
  isFinalized: false,

  // A measurement starts in the units the app is set to.
  activate: () =>
    set({
      isActive: true,
      points: [],
      undonePoints: [],
      isFinalized: false,
      unitSystem: useSettingsStore.getState().units,
    }),

  deactivate: () => set({ isActive: false, points: [], undonePoints: [], isFinalized: false }),

  setMode: (mode) => set({ mode, points: [], undonePoints: [], isFinalized: false }),

  addPoint: (point) => {
    const { isFinalized } = get();
    if (isFinalized) return;
    set((s) => ({ points: [...s.points, point], undonePoints: [] }));
  },

  removePoint: (index) =>
    set((s) => {
      const next = s.points.filter((_, i) => i !== index);
      return {
        points: next,
        isFinalized: next.length < 3 ? false : s.isFinalized,
      };
    }),

  movePoint: (index, lngLat) =>
    set((s) => {
      const next = [...s.points];
      next[index] = lngLat;
      return { points: next };
    }),

  undo: () =>
    set((s) => {
      const last = s.points.at(-1);
      if (last === undefined) return s;
      return {
        points: s.points.slice(0, -1),
        undonePoints: [...s.undonePoints, last],
        isFinalized: false,
      };
    }),

  redo: () =>
    set((s) => {
      const restored = s.undonePoints.at(-1);
      if (restored === undefined) return s;
      return {
        points: [...s.points, restored],
        undonePoints: s.undonePoints.slice(0, -1),
      };
    }),

  clear: () => set({ points: [], undonePoints: [], isFinalized: false }),

  finalize: () => {
    const { points, mode } = get();
    if (mode === "line" && points.length < 2) return;
    if (mode === "polygon" && points.length < 3) return;
    set({ isFinalized: true });
  },

  setUnitSystem: (unitSystem) => set({ unitSystem }),
}));
