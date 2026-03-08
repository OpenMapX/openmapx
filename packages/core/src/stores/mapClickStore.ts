import { create } from "zustand";
import type { LngLat } from "../types/geometry";

interface MapClickState {
  clickedLngLat: LngLat | null;
  setClickedLngLat: (lngLat: LngLat | null) => void;
}

export const useMapClickStore = create<MapClickState>((set) => ({
  clickedLngLat: null,
  setClickedLngLat: (clickedLngLat) => set({ clickedLngLat }),
}));
