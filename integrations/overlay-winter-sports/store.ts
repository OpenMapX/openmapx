import { createOverlayStore } from "@openmapx/core";

export const useWinterSportsStore = createOverlayStore({
  overlayId: "winter-sports",
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
