import { createOverlayStore } from "@openmapx/core";

export type EnvironmentSensorType =
  | "temperature"
  | "humidity"
  | "pm25"
  | "pm10"
  | "pressure"
  | "uv"
  | "noise";

export const useEnvironmentStore = createOverlayStore({
  overlayId: "environment",
  extra: {
    sensorType: "temperature" as EnvironmentSensorType,
    loading: false,
    stationCount: 0,
  },
  actions: (set) => ({
    setSensorType: (type: EnvironmentSensorType) => set({ sensorType: type }),
    setLoading: (loading: boolean) => set({ loading }),
    setStationCount: (count: number) => set({ stationCount: count }),
  }),
  onClose: () => ({
    stationCount: 0,
  }),
});
