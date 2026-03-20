import { createOverlayStore } from "./createOverlayStore";

export const useWinterSportsStore = createOverlayStore({
  extra: {
    loading: false,
    selectedFeatureId: null as string | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    selectFeature: (selectedFeatureId: string | null) => set({ selectedFeatureId }),
    clearSelection: () => set({ selectedFeatureId: null }),
  }),
  onClose: () => ({ selectedFeatureId: null }),
});
