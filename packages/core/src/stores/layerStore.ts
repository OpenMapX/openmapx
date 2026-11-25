import { create } from "zustand";
import { getStorage } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";

export type MapLayer = "default" | "satellite" | "terrain" | "cycling";

const GLOBE_STORAGE_KEY = STORAGE_KEYS.globeView.key;
const GLOBE_LIGHTING_STORAGE_KEY = STORAGE_KEYS.globeLighting.key;

function readGlobePreference(): boolean {
  return getStorage().getString(GLOBE_STORAGE_KEY) === "true";
}

/** Real-time day and night on the globe is on unless the user turned it off. */
function readGlobeLightingPreference(): boolean {
  return getStorage().getString(GLOBE_LIGHTING_STORAGE_KEY) !== "false";
}

interface LayerState {
  activeLayer: MapLayer;
  setActiveLayer: (layer: MapLayer) => void;
  globeView: boolean;
  /** Transient camera intent; explicit deep-link cameras must not be replaced by a reveal. */
  globeCameraBehavior: "reveal" | "preserve";
  setGlobeView: (enabled: boolean, cameraBehavior?: "reveal" | "preserve") => void;
  /** Real-time day and night, city lights and the Sun on the zoomed-out globe. */
  globeLighting: boolean;
  setGlobeLighting: (enabled: boolean) => void;
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
  globeLighting: readGlobeLightingPreference(),
  setGlobeLighting: (globeLighting) => {
    getStorage().setString(GLOBE_LIGHTING_STORAGE_KEY, String(globeLighting));
    set({ globeLighting });
  },
}));
