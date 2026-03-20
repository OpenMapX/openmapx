import { createOverlayStore } from "./createOverlayStore";

export const useHikingStore = createOverlayStore({
  extra: {
    loading: false,
    selectedTrailId: null as number | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    selectTrail: (selectedTrailId: number | null) => set({ selectedTrailId }),
    clearSelection: () => set({ selectedTrailId: null }),
  }),
  onClose: () => ({ selectedTrailId: null }),
});
