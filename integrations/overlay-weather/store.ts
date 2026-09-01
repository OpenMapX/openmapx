import type {
  CurrentWeather,
  RadarFrame,
  TemperatureUnit,
  WeatherSubLayer,
  WindSpeedUnit,
} from "@openmapx/core";
import { createOverlayStore } from "@openmapx/core";

/** Every sub-layer the overlay can render; all but radar need an OpenWeatherMap key. */
export const WEATHER_SUB_LAYERS: { key: WeatherSubLayer; needsOwm: boolean }[] = [
  { key: "radar", needsOwm: false },
  { key: "temperature", needsOwm: true },
  { key: "clouds", needsOwm: true },
  { key: "wind", needsOwm: true },
  { key: "pressure", needsOwm: true },
  { key: "precipitation", needsOwm: true },
];

/**
 * The sub-layer to actually render. `activeSubLayer` records what was asked
 * for (a deep link, or a choice made before an OWM key was removed) and is
 * kept so it takes effect as soon as OWM is available; until then an OWM
 * layer would only produce 503 tiles, so radar, which needs no key, stands in.
 */
export function effectiveWeatherSubLayer(state: {
  activeSubLayer: WeatherSubLayer;
  owmAvailable: boolean;
}): WeatherSubLayer {
  const needsOwm =
    WEATHER_SUB_LAYERS.find((layer) => layer.key === state.activeSubLayer)?.needsOwm ?? true;
  return needsOwm && !state.owmAvailable ? "radar" : state.activeSubLayer;
}

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
