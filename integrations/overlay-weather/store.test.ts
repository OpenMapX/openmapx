import { describe, expect, it } from "vitest";
import { effectiveWeatherSubLayer, useWeatherStore, WEATHER_SUB_LAYERS } from "./store.js";

describe("effectiveWeatherSubLayer", () => {
  it("falls back to radar while an OpenWeatherMap layer is requested but OWM is unavailable", () => {
    expect(effectiveWeatherSubLayer({ activeSubLayer: "wind", owmAvailable: false })).toBe("radar");
    expect(effectiveWeatherSubLayer({ activeSubLayer: "temperature", owmAvailable: false })).toBe(
      "radar",
    );
  });

  it("honours the requested layer once OWM is available", () => {
    expect(effectiveWeatherSubLayer({ activeSubLayer: "wind", owmAvailable: true })).toBe("wind");
  });

  it("never rewrites radar, which needs no OWM key", () => {
    expect(effectiveWeatherSubLayer({ activeSubLayer: "radar", owmAvailable: false })).toBe(
      "radar",
    );
    expect(effectiveWeatherSubLayer({ activeSubLayer: "radar", owmAvailable: true })).toBe("radar");
  });

  it("keeps the requested layer in the store so it applies when OWM becomes available", () => {
    useWeatherStore.getState().setActiveSubLayer("wind");
    useWeatherStore.getState().setOwmAvailable(false);
    expect(useWeatherStore.getState().activeSubLayer).toBe("wind");
    expect(effectiveWeatherSubLayer(useWeatherStore.getState())).toBe("radar");

    useWeatherStore.getState().setOwmAvailable(true);
    expect(effectiveWeatherSubLayer(useWeatherStore.getState())).toBe("wind");
  });

  it("lists radar as the only layer that does not need OWM", () => {
    expect(WEATHER_SUB_LAYERS.filter((l) => !l.needsOwm).map((l) => l.key)).toEqual(["radar"]);
    expect(WEATHER_SUB_LAYERS.map((l) => l.key)).toEqual([
      "radar",
      "temperature",
      "clouds",
      "wind",
      "pressure",
      "precipitation",
    ]);
  });
});
