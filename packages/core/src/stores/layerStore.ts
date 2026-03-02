import { create } from "zustand";

export type MapLayer = "default" | "satellite" | "terrain";

interface LayerState {
  activeLayer: MapLayer;
  showTraffic: boolean;
  showTransit: boolean;
  setActiveLayer: (layer: MapLayer) => void;
  setShowTraffic: (show: boolean) => void;
  setShowTransit: (show: boolean) => void;
}

export const useLayerStore = create<LayerState>((set) => ({
  activeLayer: "default",
  showTraffic: false,
  showTransit: false,
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  setShowTraffic: (showTraffic) => set({ showTraffic }),
  setShowTransit: (showTransit) => set({ showTransit }),
}));
