import { create } from "zustand";

interface StreetViewState {
  panelOpen: boolean;
  coverageVisible: boolean;
  activeImageId: string | null;
  openPanel: () => void;
  closePanel: () => void;
  setCoverageVisible: (visible: boolean) => void;
  setActiveImageId: (id: string | null) => void;
  closeViewer: () => void;
}

export const useStreetViewStore = create<StreetViewState>((set) => ({
  panelOpen: false,
  coverageVisible: false,
  activeImageId: null,
  openPanel: () => set({ panelOpen: true, coverageVisible: true }),
  closePanel: () => set({ panelOpen: false, coverageVisible: false, activeImageId: null }),
  setCoverageVisible: (coverageVisible) => set({ coverageVisible }),
  setActiveImageId: (activeImageId) => set({ activeImageId }),
  closeViewer: () => set({ activeImageId: null }),
}));
