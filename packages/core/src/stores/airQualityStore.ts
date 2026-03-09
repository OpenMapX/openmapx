import { create } from "zustand";

interface AirQualityState {
  panelOpen: boolean;
  layerVisible: boolean;
  openPanel: () => void;
  closePanel: () => void;
  setLayerVisible: (visible: boolean) => void;
}

export const useAirQualityStore = create<AirQualityState>((set) => ({
  panelOpen: false,
  layerVisible: false,
  openPanel: () => set({ panelOpen: true, layerVisible: true }),
  closePanel: () => set({ panelOpen: false, layerVisible: false }),
  setLayerVisible: (layerVisible) => set({ layerVisible }),
}));
