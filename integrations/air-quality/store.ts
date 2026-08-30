import type { AirQualityWarningCode, Pollutant } from "@openmapx/air-quality";
import { createOverlayStore } from "@openmapx/core";

export type AirQualityMode =
  | { kind: "monitors"; pollutant: Pollutant }
  | { kind: "eea-raster"; frameTime: string | null };

export type AirQualityMapError = "quota" | "unavailable";

interface SnapshotStatus {
  warnings: AirQualityWarningCode[];
  truncated: boolean;
  activeSourceIds: string[];
  stationCount: number;
}

const DEFAULT_MODE: AirQualityMode = { kind: "monitors", pollutant: "pm25" };

function emptyRuntimeStatus() {
  return {
    loading: false,
    error: null as AirQualityMapError | null,
    warnings: [] as AirQualityWarningCode[],
    truncated: false,
    hasData: false,
    stationCount: 0,
    activeSourceIds: [] as string[],
  };
}

export const useAirQualityStore = createOverlayStore({
  overlayId: "air-quality",
  extra: {
    mode: DEFAULT_MODE as AirQualityMode,
    ...emptyRuntimeStatus(),
  },
  actions: (set) => ({
    setMode: (kind: AirQualityMode["kind"]) =>
      set((state) =>
        state.mode.kind === kind
          ? {}
          : {
              mode:
                kind === "monitors"
                  ? { kind: "monitors", pollutant: "pm25" }
                  : { kind: "eea-raster", frameTime: null },
              ...emptyRuntimeStatus(),
            },
      ),
    setMonitorPollutant: (pollutant: Pollutant) =>
      set((state) =>
        state.mode.kind === "monitors" && state.mode.pollutant === pollutant
          ? {}
          : { mode: { kind: "monitors", pollutant }, ...emptyRuntimeStatus() },
      ),
    setRasterFrame: (frameTime: string | null) =>
      set({ mode: { kind: "eea-raster", frameTime }, ...emptyRuntimeStatus() }),
    setLoading: (loading: boolean) =>
      set({ loading, ...(loading ? { error: null as AirQualityMapError | null } : {}) }),
    setSnapshotStatus: (status: SnapshotStatus) =>
      set({
        loading: false,
        error: null,
        warnings: [...new Set(status.warnings)],
        truncated: status.truncated,
        hasData: true,
        stationCount: status.stationCount,
        activeSourceIds: [...new Set(status.activeSourceIds)].sort(),
      }),
    setRequestError: (error: AirQualityMapError) => set({ loading: false, error }),
    clearSnapshotStatus: () => set(emptyRuntimeStatus()),
    reset: () =>
      set({
        panelOpen: false,
        layerVisible: false,
        mode: DEFAULT_MODE as AirQualityMode,
        ...emptyRuntimeStatus(),
      }),
  }),
  onClose: emptyRuntimeStatus,
});
