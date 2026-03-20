import { createOverlayStore } from "./createOverlayStore";

export const useAirQualityStore = createOverlayStore({
  extra: { loading: false },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
  }),
});
