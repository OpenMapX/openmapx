import { createOverlayStore } from "./createOverlayStore";

export const useAirQualityStore = createOverlayStore({
  overlayId: "air-quality",
  extra: { loading: false },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
  }),
});
