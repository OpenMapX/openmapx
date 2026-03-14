import { create } from "zustand";
import type { Place } from "../types/place";
import type { MergedDeparture } from "../types/transit";

interface PlaceState {
  selectedPlace: Place | null;
  sidePanelCollapsed: boolean;
  /** Route currently shown in LineDetail or TripDetailView — shared with map layers. */
  activeRouteId: string | null;
  /** Departure currently shown in TripDetailView. */
  activeTripDep: MergedDeparture | null;
  setSelectedPlace: (place: Place | null) => void;
  setSidePanelCollapsed: (collapsed: boolean) => void;
  setActiveRouteId: (routeId: string | null) => void;
  setActiveTripDep: (dep: MergedDeparture | null) => void;
}

export const usePlaceStore = create<PlaceState>((set) => ({
  selectedPlace: null,
  sidePanelCollapsed: false,
  activeRouteId: null,
  activeTripDep: null,
  setSelectedPlace: (selectedPlace) =>
    set({ selectedPlace, sidePanelCollapsed: false, activeRouteId: null, activeTripDep: null }),
  setSidePanelCollapsed: (sidePanelCollapsed) => set({ sidePanelCollapsed }),
  setActiveRouteId: (activeRouteId) => set({ activeRouteId }),
  setActiveTripDep: (activeTripDep) => set({ activeTripDep }),
}));
