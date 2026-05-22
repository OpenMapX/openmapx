import type { MergedDeparture } from "@openmapx/mobility-core/transit";
import { create } from "zustand";
import type { Place } from "../types/place";

export interface TransitMapFocus {
  kind: "stop-area" | "platform" | "fare-zone" | "parking";
  id: string;
  revealToken: number;
}

interface PlaceState {
  selectedPlace: Place | null;
  /** Route currently shown in LineDetail or TripDetailView — shared with map layers. */
  activeRouteId: string | null;
  /** Departure currently shown in TripDetailView. */
  activeTripDep: MergedDeparture | null;
  /** Selection-bound transit map detail shown for the current place. */
  transitMapFocus: TransitMapFocus | null;
  setSelectedPlace: (place: Place | null) => void;
  setActiveRouteId: (routeId: string | null) => void;
  setActiveTripDep: (dep: MergedDeparture | null) => void;
  focusTransitMapFeature: (
    focus: Pick<TransitMapFocus, "kind" | "id">,
    options?: { reveal?: boolean },
  ) => void;
  clearTransitMapFocus: () => void;
}

export const usePlaceStore = create<PlaceState>((set) => ({
  selectedPlace: null,
  activeRouteId: null,
  activeTripDep: null,
  transitMapFocus: null,
  setSelectedPlace: (selectedPlace) =>
    set({ selectedPlace, activeRouteId: null, activeTripDep: null, transitMapFocus: null }),
  setActiveRouteId: (activeRouteId) => set({ activeRouteId }),
  setActiveTripDep: (activeTripDep) => set({ activeTripDep }),
  focusTransitMapFeature: (focus, options) =>
    set((state) => {
      const previous = state.transitMapFocus;
      const revealToken = options?.reveal
        ? (previous?.kind === focus.kind && previous.id === focus.id ? previous.revealToken : 0) + 1
        : previous?.kind === focus.kind && previous.id === focus.id
          ? previous.revealToken
          : 0;
      return {
        transitMapFocus: {
          ...focus,
          revealToken,
        },
      };
    }),
  clearTransitMapFocus: () => set({ transitMapFocus: null }),
}));
