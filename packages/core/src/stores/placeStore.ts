import { create } from "zustand";
import type { Place } from "../types/place";

interface PlaceState {
  selectedPlace: Place | null;
  sidePanelCollapsed: boolean;
  setSelectedPlace: (place: Place | null) => void;
  setSidePanelCollapsed: (collapsed: boolean) => void;
}

export const usePlaceStore = create<PlaceState>((set) => ({
  selectedPlace: null,
  sidePanelCollapsed: false,
  setSelectedPlace: (selectedPlace) => set({ selectedPlace, sidePanelCollapsed: false }),
  setSidePanelCollapsed: (sidePanelCollapsed) => set({ sidePanelCollapsed }),
}));
