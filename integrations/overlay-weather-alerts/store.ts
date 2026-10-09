import { createOverlayStore } from "@openmapx/core";

const ALL_SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;

export type AlertSeverity = (typeof ALL_SEVERITIES)[number];
export { ALL_SEVERITIES };

export const useWeatherAlertStore = createOverlayStore({
  overlayId: "weather-alerts",
  extra: {
    loading: false,
    activeSeverities: new Set<string>(ALL_SEVERITIES) as Set<string>,
    alertCount: 0,
    lastUpdated: null as number | null,
    /** The last refresh failed: no hazards source answered, which is not "no alerts". */
    unavailable: false,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setUnavailable: (unavailable: boolean) => set({ unavailable }),
    toggleSeverity: (severity: string) =>
      set((state) => {
        const next = new Set(state.activeSeverities);
        if (next.has(severity)) {
          if (next.size > 1) next.delete(severity);
        } else {
          next.add(severity);
        }
        return { activeSeverities: next };
      }),
    setAlertCount: (alertCount: number) => set({ alertCount }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
  }),
  onClose: () => ({ alertCount: 0, unavailable: false }),
});
