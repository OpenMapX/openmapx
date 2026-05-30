import { create } from "zustand";
import type { LngLat } from "../types/geometry";

/** Resolved airport endpoint for the flight arc shown on the map. */
export interface FlightEndpoint {
  iata: string;
  name: string;
  coordinates: LngLat;
}

interface FlightState {
  /** Origin airport, or null until resolved. */
  from: FlightEndpoint | null;
  /** Destination airport, or null until resolved. */
  to: FlightEndpoint | null;
  setEndpoints: (from: FlightEndpoint | null, to: FlightEndpoint | null) => void;
  clear: () => void;
}

/**
 * Shared state for the flights feature: the two resolved airports the
 * `FlightPanel` has settled on, consumed by `FlightArcLayer` to draw the
 * great-circle line. Mirrors how directions/transit share state via stores
 * rather than threading props through the map tree.
 */
export const useFlightStore = create<FlightState>((set) => ({
  from: null,
  to: null,
  setEndpoints: (from, to) => set({ from, to }),
  clear: () => set({ from: null, to: null }),
}));
