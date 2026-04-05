import type { LngLat, UnitSystem } from "@openmapx/core";
import { create } from "zustand";

export type MeasurementMode = "line" | "polygon";
export type { UnitSystem };

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

  activate: () => set({ isActive: true, points: [], undonePoints: [], isFinalized: false }),

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
      if (s.points.length === 0) return s;
      const last = s.points[s.points.length - 1];
      return {
        points: s.points.slice(0, -1),
        undonePoints: [...s.undonePoints, last],
        isFinalized: false,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.undonePoints.length === 0) return s;
      const restored = s.undonePoints[s.undonePoints.length - 1];
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
