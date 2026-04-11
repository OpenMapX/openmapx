import type { TravelMode, Waypoint } from "@integrations/routing/types";
import type { TripItinerary } from "@integrations/transit/types";
import { create } from "zustand";
import type { LngLat } from "../types/geometry";

let waypointCounter = 0;
function newWaypointId(): string {
  return `wp_${++waypointCounter}_${Date.now()}`;
}

function deriveTypes(wps: Waypoint[]): Waypoint[] {
  return wps.map((wp, i) => ({
    ...wp,
    type: i === 0 ? "origin" : i === wps.length - 1 ? "destination" : "waypoint",
  }));
}

function makeEmptyWaypoint(): Waypoint {
  return { id: newWaypointId(), coords: null, label: "", type: "waypoint" };
}

/** Compute backward-compat derived fields from waypoints. */
function derived(wps: Waypoint[]) {
  const last = wps.length - 1;
  return {
    origin: wps[0]?.coords ?? null,
    originLabel: wps[0]?.label ?? "",
    destination: wps[last]?.coords ?? null,
    destinationLabel: wps[last]?.label ?? "",
  };
}

const MAX_WAYPOINTS = 10;

export interface DirectionsState {
  isOpen: boolean;
  waypoints: Waypoint[];
  mode: TravelMode;
  activeRouteIndex: number;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  units: "metric" | "imperial";
  transitItineraries: TripItinerary[];
  activeItineraryIndex: number;
  transitDepartureTime: "now" | Date;
  transitArrivalTime: Date | null;

  // Derived from waypoints (kept in sync for backward compat)
  origin: LngLat | null;
  originLabel: string;
  destination: LngLat | null;
  destinationLabel: string;

  // Actions
  open: () => void;
  close: () => void;
  setWaypoint: (index: number, coords: LngLat | null, label: string) => void;
  addWaypoint: (afterIndex: number) => void;
  removeWaypoint: (index: number) => void;
  reorderWaypoints: (fromIndex: number, toIndex: number) => void;
  reverseWaypoints: () => void;
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

function initialWaypoints(): Waypoint[] {
  return deriveTypes([
    { id: newWaypointId(), coords: null, label: "", type: "origin" },
    { id: newWaypointId(), coords: null, label: "", type: "destination" },
  ]);
}

export const useDirectionsStore = create<DirectionsState>((set, get) => {
  const initWps = initialWaypoints();
  return {
    isOpen: false,
    waypoints: initWps,
    ...derived(initWps),
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
    close: () => {
      const wps = initialWaypoints();
      set({
        isOpen: false,
        waypoints: wps,
        ...derived(wps),
        activeRouteIndex: 0,
        transitItineraries: [],
        activeItineraryIndex: 0,
        transitDepartureTime: "now" as const,
        transitArrivalTime: null,
      });
    },

    setWaypoint: (index, coords, label) => {
      const wps = [...get().waypoints];
      if (index < 0 || index >= wps.length) return;
      wps[index] = { ...wps[index], coords, label };
      set({ waypoints: wps, ...derived(wps), activeRouteIndex: 0 });
    },

    addWaypoint: (afterIndex) => {
      const wps = [...get().waypoints];
      if (wps.length >= MAX_WAYPOINTS) return;
      const newWp = makeEmptyWaypoint();
      wps.splice(afterIndex + 1, 0, newWp);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, ...derived(typed), activeRouteIndex: 0 });
    },

    removeWaypoint: (index) => {
      const wps = [...get().waypoints];
      if (wps.length <= 2) return;
      wps.splice(index, 1);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, ...derived(typed), activeRouteIndex: 0 });
    },

    reorderWaypoints: (fromIndex, toIndex) => {
      const wps = [...get().waypoints];
      const [moved] = wps.splice(fromIndex, 1);
      wps.splice(toIndex, 0, moved);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, ...derived(typed), activeRouteIndex: 0 });
    },

    reverseWaypoints: () => {
      const wps = [...get().waypoints].reverse();
      const typed = deriveTypes(wps);
      set({ waypoints: typed, ...derived(typed), activeRouteIndex: 0 });
    },

    setOrigin: (coords, label) => {
      const wps = [...get().waypoints];
      wps[0] = { ...wps[0], coords, label };
      set({ waypoints: wps, ...derived(wps), activeRouteIndex: 0 });
    },

    setDestination: (coords, label) => {
      const wps = [...get().waypoints];
      const last = wps.length - 1;
      wps[last] = { ...wps[last], coords, label };
      set({ waypoints: wps, ...derived(wps), activeRouteIndex: 0 });
    },

    swapOriginDestination: () => {
      get().reverseWaypoints();
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
  };
});
