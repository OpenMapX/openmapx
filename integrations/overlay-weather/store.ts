import type {
  CurrentWeather,
  RadarFrame,
  TemperatureUnit,
  WeatherSubLayer,
  WindSpeedUnit,
} from "@openmapx/core";
import { createOverlayStore } from "@openmapx/core";

export const useWeatherStore = createOverlayStore({
  overlayId: "weather",
  extra: {
    activeSubLayer: "radar" as WeatherSubLayer,
    owmAvailable: false,

    radarPlaying: false,
    radarFrameIndex: 0,
    radarPastFrames: [] as RadarFrame[],
    radarNowcastFrames: [] as RadarFrame[],
    radarHost: "",

    currentWeather: null as CurrentWeather | null,
    locationName: "",

    temperatureUnit: "celsius" as TemperatureUnit,
    windSpeedUnit: "kmh" as WindSpeedUnit,

    loading: false,
    radarLoading: false,
    radarUnavailable: false,
  },
  actions: (set) => ({
    setActiveSubLayer: (layer: WeatherSubLayer) => set({ activeSubLayer: layer }),
    setOwmAvailable: (available: boolean) => set({ owmAvailable: available }),
    setRadarPlaying: (playing: boolean) => set({ radarPlaying: playing }),
    setRadarFrameIndex: (index: number) => set({ radarFrameIndex: index }),
    setRadarMeta: (host: string, past: RadarFrame[], nowcast: RadarFrame[]) =>
      set({ radarHost: host, radarPastFrames: past, radarNowcastFrames: nowcast }),
    setCurrentWeather: (weather: CurrentWeather | null) => set({ currentWeather: weather }),
    setLocationName: (name: string) => set({ locationName: name }),
    setTemperatureUnit: (unit: TemperatureUnit) => set({ temperatureUnit: unit }),
    setWindSpeedUnit: (unit: WindSpeedUnit) => set({ windSpeedUnit: unit }),
    setLoading: (loading: boolean) => set({ loading }),
    setRadarLoading: (loading: boolean) => set({ radarLoading: loading }),
    setRadarUnavailable: (unavailable: boolean) => set({ radarUnavailable: unavailable }),
  }),
  onClose: () => ({
    radarPlaying: false,
    radarFrameIndex: 0,
    currentWeather: null,
    locationName: "",
  }),
});
