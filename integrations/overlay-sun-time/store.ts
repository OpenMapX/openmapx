import { createOverlayStore } from "@openmapx/core";

export const useSunTimeStore = createOverlayStore({
  overlayId: "sun-time",
  extra: {
    showTerminator: true,
    showTimeZones: false,
    /** null follows the wall clock; a number pins the overlay to that instant. */
    timeMs: null as number | null,
    tzLoading: false,
  },
  actions: (set) => ({
    setShowTerminator: (showTerminator: boolean) => set({ showTerminator }),
    setShowTimeZones: (showTimeZones: boolean) => set({ showTimeZones }),
    setTimeMs: (timeMs: number | null) => set({ timeMs }),
    resetToNow: () => set({ timeMs: null }),
    setTzLoading: (tzLoading: boolean) => set({ tzLoading }),
  }),
  onClose: () => ({
    timeMs: null,
  }),
});
