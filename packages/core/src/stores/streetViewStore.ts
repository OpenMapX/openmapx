import { create } from "zustand";

interface StreetViewState {
  showCoverage: boolean;
  activeImageId: string | null;
  setShowCoverage: (show: boolean) => void;
  setActiveImageId: (id: string | null) => void;
  closeViewer: () => void;
}

export const useStreetViewStore = create<StreetViewState>((set) => ({
  showCoverage: false,
  activeImageId: null,
  setShowCoverage: (showCoverage) => set({ showCoverage }),
  setActiveImageId: (activeImageId) => set({ activeImageId }),
  closeViewer: () => set({ activeImageId: null }),
}));
