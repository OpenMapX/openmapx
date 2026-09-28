import { create } from "zustand";
import { getStorage } from "../platform/storage";

export type MapLayer = "default" | "satellite" | "terrain" | "cycling";

const GLOBE_STORAGE_KEY = "openmapx:globeView";

function readGlobePreference(): boolean {
  return getStorage().getString(GLOBE_STORAGE_KEY) === "true";
}

interface LayerState {
  activeLayer: MapLayer;
  setActiveLayer: (layer: MapLayer) => void;
  globeView: boolean;
  /** Transient camera intent; explicit deep-link cameras must not be replaced by a reveal. */
  globeCameraBehavior: "reveal" | "preserve";
  setGlobeView: (enabled: boolean, cameraBehavior?: "reveal" | "preserve") => void;
}

export const useLayerStore = create<LayerState>((set) => ({
  activeLayer: "default",
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  globeView: readGlobePreference(),
  globeCameraBehavior: "reveal",
  setGlobeView: (globeView, globeCameraBehavior = "reveal") => {
    getStorage().setString(GLOBE_STORAGE_KEY, String(globeView));
    set({ globeView, globeCameraBehavior });
  },
}));
