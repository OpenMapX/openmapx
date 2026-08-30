import { createOverlayStore } from "@openmapx/core";

export const useAirQualityStore = createOverlayStore({
  overlayId: "air-quality",
  extra: { loading: false, error: null as "coverage" | "quota" | "unavailable" | null },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setError: (error: "coverage" | "quota" | "unavailable" | null) => set({ error }),
  }),
});
