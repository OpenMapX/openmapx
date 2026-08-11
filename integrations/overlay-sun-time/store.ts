import { createOverlayStore } from "@openmapx/core";

export const useSunTimeStore = createOverlayStore({
  overlayId: "sun-time",
  extra: {
    showTerminator: true,
    showTimeZones: false,
    /** null follows the wall clock; a number pins the overlay to that instant. */
    timeMs: null as number | null,
    tzLoading: false,
    /** The shared "now" tick used whenever timeMs is null. map-layer.tsx owns
     *  the single interval that advances this — the legend reads it instead of
     *  keeping a second timer, so the map and the legend can never drift. */
    nowMs: Date.now(),
  },
  actions: (set) => ({
    setShowTerminator: (showTerminator: boolean) => set({ showTerminator }),
    setShowTimeZones: (showTimeZones: boolean) => set({ showTimeZones }),
    setTimeMs: (timeMs: number | null) => set({ timeMs }),
    resetToNow: () => set({ timeMs: null }),
    setTzLoading: (tzLoading: boolean) => set({ tzLoading }),
    setNowMs: (nowMs: number) => set({ nowMs }),
  }),
  onClose: () => ({
    timeMs: null,
  }),
});
