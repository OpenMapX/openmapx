import { create } from "zustand";
import type { Place } from "../types/place";

interface PlaceState {
  selectedPlace: Place | null;
  setSelectedPlace: (place: Place | null) => void;
}

export const usePlaceStore = create<PlaceState>((set) => ({
  selectedPlace: null,
  setSelectedPlace: (selectedPlace) => set({ selectedPlace }),
}));
