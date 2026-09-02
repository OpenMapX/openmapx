import { create } from "zustand";
import type { LngLat } from "../types/geometry";

interface ParkingState {
  /** Which parked record the panel is showing; null shows the first one. */
  selectedParkedId: string | null;
  /** The map click handler consumes the next tap while this is armed. */
  picking: boolean;
  /** The tap the handler captured, waiting for the panel to commit it. */
  pickedCoords: LngLat | null;
  select: (id: string | null) => void;
  setPicking: (v: boolean) => void;
  setPickedCoords: (coords: LngLat | null) => void;
  reset: () => void;
}

export const useParkingStore = create<ParkingState>((set) => ({
  selectedParkedId: null,
  picking: false,
  pickedCoords: null,
  select: (selectedParkedId) => set({ selectedParkedId }),
  setPicking: (picking) => set({ picking }),
  // Capturing a point ends the pick: leaving it armed would swallow the next
  // tap the user makes to dismiss or reposition the panel.
  setPickedCoords: (pickedCoords) => set({ pickedCoords, picking: false }),
  reset: () => set({ selectedParkedId: null, picking: false, pickedCoords: null }),
}));
