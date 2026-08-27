import type { LngLat } from "@openmapx/core";
import type { WeatherProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const COORDS: LngLat = [13.405, 52.52];

function mockOk(data: unknown) {
  return Response.json(data);
}

type LoadedWeatherProvider = WeatherProvider &
  Required<Pick<WeatherProvider, "getHourlyForecast" | "getDailyForecast">>;

function getProvider(): LoadedWeatherProvider {
  const ctx = createMockIntegrationContext();
  setup(ctx);
  const provider = ctx.registered.weather[0];
  if (!provider?.getHourlyForecast || !provider.getDailyForecast) {
    throw new Error("Open-Meteo provider was not registered with forecast methods");
  }
  return provider as LoadedWeatherProvider;
}

function currentResponse() {
  return {
    current: {
      time: "2026-03-10T10:00",
      temperature_2m: 9.5,
      relative_humidity_2m: 68,
      apparent_temperature: 7.2,
      is_day: 1,
      precipitation: 0.3,
      rain: 0.3,
      showers: 0,
      snowfall: 0,
      weather_code: 61,
      cloud_cover: 45,
      pressure_msl: 1011,
      surface_pressure: 1005,
      wind_speed_10m: 14,
      wind_direction_10m: 220,
      wind_gusts_10m: 30,
    },
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Open-Meteo weather provider", () => {
  it("registers with id and priority", () => {
    const provider = getProvider();
    expect(provider.id).toBe("open-meteo");
    expect(provider.priority).toBe(10);
  });

  it("passes the upstream WMO weather_code through unchanged and maps current fields", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));

    const res = await getProvider().getCurrentWeather(COORDS);

    expect(res.source).toBe("open-meteo");
    expect(res.location).toEqual(COORDS);
    expect(res.current).toEqual({
      temperature: 9.5,
      feelsLike: 7.2,
      humidity: 68,
      pressure: 1011, // pressure_msl, not surface_pressure
      windSpeed: 14,
      windDirection: 220,
      windGusts: 30,
      precipitation: 0.3,
      cloudCover: 45,
      weatherCode: 61, // passthrough, no remap
      isDay: true, // is_day === 1
      time: "2026-03-10T10:00",
    });
  });

  it("reports isDay false when is_day is 0", async () => {
    const data = currentResponse();
    data.current.is_day = 0;
    mockFetch.mockResolvedValueOnce(mockOk(data));
    expect((await getProvider().getCurrentWeather(COORDS)).current.isDay).toBe(false);
  });

  it("requests metric units (kmh wind, no temp/precip overrides) by default", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));
    await getProvider().getCurrentWeather(COORDS);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("latitude=52.52&longitude=13.405");
    expect(url).toContain("wind_speed_unit=kmh");
    expect(url).not.toContain("temperature_unit=fahrenheit");
    expect(url).not.toContain("precipitation_unit=inch");
    expect(url).toContain("timezone=auto");
  });

  it("forwards imperial unit params to the upstream URL", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));
    await getProvider().getCurrentWeather(COORDS, { units: "imperial" });

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("temperature_unit=fahrenheit");
    expect(url).toContain("wind_speed_unit=mph");
    expect(url).toContain("precipitation_unit=inch");
  });

  it("maps the parallel hourly arrays into points and slices to the requested hours", async () => {
    const data = {
      ...currentResponse(),
      hourly: {
        time: ["2026-03-10T10:00", "2026-03-10T11:00", "2026-03-10T12:00"],
        temperature_2m: [10, 11, 12],
        precipitation_probability: [5, 20, 60],
        precipitation: [0, 0.1, 0.8],
        weather_code: [1, 2, 63],
        cloud_cover: [10, 40, 90],
        wind_speed_10m: [12, 14, 16],
        wind_direction_10m: [180, 190, 200],
        pressure_msl: [1015, 1014, 1012],
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const hourly = await getProvider().getHourlyForecast(COORDS, 2);

    expect(hourly).toHaveLength(2);
    expect(hourly[0]).toEqual({
      time: "2026-03-10T10:00",
      temperature: 10,
      weatherCode: 1,
      precipitationProbability: 5,
      precipitation: 0,
      windSpeed: 12,
      windDirection: 180,
      cloudCover: 10,
      pressure: 1015,
    });
    expect(hourly[1]?.weatherCode).toBe(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("&hourly=temperature_2m");
  });

  it("returns an empty hourly array when the response omits hourly data", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));
    expect(await getProvider().getHourlyForecast(COORDS, 12)).toEqual([]);
  });

  it("maps daily arrays including sunrise/sunset and slices to the requested days", async () => {
    const data = {
      ...currentResponse(),
      daily: {
        time: ["2026-03-10", "2026-03-11", "2026-03-12"],
        weather_code: [61, 73, 0],
        temperature_2m_max: [12, 6, 15],
        temperature_2m_min: [4, -1, 7],
        precipitation_sum: [2.4, 5.1, 0],
        wind_speed_10m_max: [25, 30, 18],
        sunrise: ["2026-03-10T06:30", "2026-03-11T06:28", "2026-03-12T06:26"],
        sunset: ["2026-03-10T18:00", "2026-03-11T18:02", "2026-03-12T18:04"],
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const daily = await getProvider().getDailyForecast(COORDS, 2);

    expect(daily).toHaveLength(2);
    expect(daily[0]).toEqual({
      date: "2026-03-10",
      weatherCode: 61,
      temperatureMax: 12,
      temperatureMin: 4,
      precipitationSum: 2.4,
      windSpeedMax: 25,
      sunrise: "2026-03-10T06:30",
      sunset: "2026-03-10T18:00",
    });
    expect(daily[1]?.weatherCode).toBe(73);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("&daily=weather_code");
  });

  it("returns an empty daily array when the response omits daily data", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));
    expect(await getProvider().getDailyForecast(COORDS, 5)).toEqual([]);
  });
});
