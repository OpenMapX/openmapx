import { create } from "zustand";
import type { TravelMode } from "../types/directions";
import type { LngLat } from "../types/geometry";
import type { TripItinerary } from "../types/transit";

export interface DirectionsState {
  isOpen: boolean;
  origin: LngLat | null;
  originLabel: string;
  destination: LngLat | null;
  destinationLabel: string;
  mode: TravelMode;
  activeRouteIndex: number;
  // Route options
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  units: "metric" | "imperial";
  transitItineraries: TripItinerary[];
  activeItineraryIndex: number;
  transitDepartureTime: "now" | Date;
  transitArrivalTime: Date | null;
  // Actions
  open: () => void;
  close: () => void;
  setOrigin: (coords: LngLat | null, label: string) => void;
  setDestination: (coords: LngLat | null, label: string) => void;
  swapOriginDestination: () => void;
  setMode: (mode: TravelMode) => void;
  setActiveRouteIndex: (index: number) => void;
  setAvoidHighways: (v: boolean) => void;
  setAvoidTolls: (v: boolean) => void;
  setAvoidFerries: (v: boolean) => void;
  setUnits: (u: "metric" | "imperial") => void;
  setTransitItineraries: (items: TripItinerary[]) => void;
  setActiveItineraryIndex: (i: number) => void;
  setTransitDepartureTime: (t: "now" | Date) => void;
  setTransitArrivalTime: (t: Date | null) => void;
}

export const useDirectionsStore = create<DirectionsState>((set, get) => ({
  isOpen: false,
  origin: null,
  originLabel: "",
  destination: null,
  destinationLabel: "",
  mode: "driving",
  activeRouteIndex: 0,
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  units: "metric",
  transitItineraries: [],
  activeItineraryIndex: 0,
  transitDepartureTime: "now" as const,
  transitArrivalTime: null,

  open: () => set({ isOpen: true }),
  close: () =>
    set({
      isOpen: false,
      origin: null,
      originLabel: "",
      destination: null,
      destinationLabel: "",
      activeRouteIndex: 0,
      transitItineraries: [],
      activeItineraryIndex: 0,
      transitDepartureTime: "now" as const,
      transitArrivalTime: null,
    }),

  setOrigin: (coords, label) => set({ origin: coords, originLabel: label, activeRouteIndex: 0 }),
  setDestination: (coords, label) =>
    set({ destination: coords, destinationLabel: label, activeRouteIndex: 0 }),

  swapOriginDestination: () => {
    const { origin, originLabel, destination, destinationLabel } = get();
    set({
      origin: destination,
      originLabel: destinationLabel,
      destination: origin,
      destinationLabel: originLabel,
      activeRouteIndex: 0,
    });
  },

  setMode: (mode) => set({ mode, activeRouteIndex: 0 }),
  setActiveRouteIndex: (activeRouteIndex) => set({ activeRouteIndex }),
  setAvoidHighways: (avoidHighways) => set({ avoidHighways }),
  setAvoidTolls: (avoidTolls) => set({ avoidTolls }),
  setAvoidFerries: (avoidFerries) => set({ avoidFerries }),
  setUnits: (units) => set({ units }),
  setTransitItineraries: (transitItineraries) =>
    set({ transitItineraries, activeItineraryIndex: 0 }),
  setActiveItineraryIndex: (activeItineraryIndex) => set({ activeItineraryIndex }),
  setTransitDepartureTime: (transitDepartureTime) => set({ transitDepartureTime }),
  setTransitArrivalTime: (transitArrivalTime) => set({ transitArrivalTime }),
}));
