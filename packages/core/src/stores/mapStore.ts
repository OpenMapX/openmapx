import { create } from "zustand";
import type { LngLat } from "../types/geometry";

interface MapViewport {
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

interface MapState extends MapViewport {
  userLocation: LngLat | null;
  setCenter: (center: LngLat) => void;
  setZoom: (zoom: number) => void;
  setBearing: (bearing: number) => void;
  setPitch: (pitch: number) => void;
  setViewport: (viewport: Partial<MapViewport>) => void;
  setUserLocation: (location: LngLat | null) => void;
}

export const useMapStore = create<MapState>((set) => ({
  center: [0, 20],
  zoom: 2,
  bearing: 0,
  pitch: 0,
  userLocation: null,
  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  setBearing: (bearing) => set({ bearing }),
  setPitch: (pitch) => set({ pitch }),
  setViewport: (viewport) => set(viewport),
  setUserLocation: (userLocation) => set({ userLocation }),
}));
