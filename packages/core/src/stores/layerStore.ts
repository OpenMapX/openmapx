import { create } from "zustand";

export type MapLayer = "default" | "satellite" | "terrain" | "cycling";

const GLOBE_STORAGE_KEY = "openmapx:globeView";

function readGlobePreference(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(GLOBE_STORAGE_KEY) === "true";
}

interface LayerState {
  activeLayer: MapLayer;
  setActiveLayer: (layer: MapLayer) => void;
  globeView: boolean;
  setGlobeView: (enabled: boolean) => void;
}

export const useLayerStore = create<LayerState>((set) => ({
  activeLayer: "default",
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  globeView: readGlobePreference(),
  setGlobeView: (globeView) => {
    if (typeof window !== "undefined") {
      localStorage.setItem(GLOBE_STORAGE_KEY, String(globeView));
    }
    set({ globeView });
  },
}));
