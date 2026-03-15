import { create } from "zustand";

interface AirQualityState {
  panelOpen: boolean;
  layerVisible: boolean;
  loading: boolean;
  openPanel: () => void;
  closePanel: () => void;
  setLayerVisible: (visible: boolean) => void;
  setLoading: (loading: boolean) => void;
}

export const useAirQualityStore = create<AirQualityState>((set) => ({
  panelOpen: false,
  layerVisible: false,
  loading: false,
  openPanel: () => set({ panelOpen: true, layerVisible: true }),
  closePanel: () => set({ panelOpen: false, layerVisible: false }),
  setLayerVisible: (layerVisible) => set({ layerVisible }),
  setLoading: (loading) => set({ loading }),
}));
