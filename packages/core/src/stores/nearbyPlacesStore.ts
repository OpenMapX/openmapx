import { create } from "zustand";
import type { Place } from "../types/place";

interface NearbyPlacesState {
  sourcePlace: Place | null;
  radiusMetres: number;
  hoveredNearbyPlaceId: string | null;
  setSourcePlace: (place: Place | null) => void;
  setRadiusMetres: (radiusMetres: number) => void;
  setHoveredNearbyPlaceId: (id: string | null) => void;
  clearNearbyPlaces: () => void;
}

export const useNearbyPlacesStore = create<NearbyPlacesState>((set) => ({
  sourcePlace: null,
  radiusMetres: 1000,
  hoveredNearbyPlaceId: null,
  setSourcePlace: (sourcePlace) => set({ sourcePlace, hoveredNearbyPlaceId: null }),
  setRadiusMetres: (radiusMetres) => set({ radiusMetres }),
  setHoveredNearbyPlaceId: (hoveredNearbyPlaceId) => set({ hoveredNearbyPlaceId }),
  clearNearbyPlaces: () =>
    set({
      sourcePlace: null,
      radiusMetres: 1000,
      hoveredNearbyPlaceId: null,
    }),
}));
