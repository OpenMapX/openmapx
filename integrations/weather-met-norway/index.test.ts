import type { LngLat } from "@openmapx/core";
import type { WeatherProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const COORDS: LngLat = [10.7522, 59.9139];

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
    throw new Error("MET Norway provider was not registered with forecast methods");
  }
  return provider as LoadedWeatherProvider;
}

/**
 * Compact response with a daytime clear-sky symbol on the first entry, a
 * later midday entry, and a multi-day spread so daily aggregation has data.
 */
function sampleResponse() {
  return {
    properties: {
      meta: { updated_at: "2026-03-10T09:00:00Z" },
      timeseries: [
        {
          time: "2026-03-10T10:00:00Z",
          data: {
            instant: {
              details: {
                air_temperature: 10,
                air_pressure_at_sea_level: 1015,
                cloud_area_fraction: 12,
                relative_humidity: 60,
                wind_from_direction: 180,
                wind_speed: 5,
                wind_speed_of_gust: 9,
              },
            },
            next_1_hours: {
              summary: { symbol_code: "clearsky_day" },
              details: { precipitation_amount: 0, probability_of_precipitation: 5 },
            },
            next_6_hours: {
              summary: { symbol_code: "cloudy" },
              details: { precipitation_amount: 1 },
            },
          },
        },
        {
          time: "2026-03-10T12:00:00Z",
          data: {
            instant: {
              details: {
                air_temperature: 14,
                air_pressure_at_sea_level: 1014,
                cloud_area_fraction: 80,
                relative_humidity: 55,
                wind_from_direction: 200,
                wind_speed: 7,
              },
            },
            next_1_hours: {
              summary: { symbol_code: "lightrain" },
              details: { precipitation_amount: 0.4, probability_of_precipitation: 40 },
            },
          },
        },
        {
          time: "2026-03-11T12:00:00Z",
          data: {
            instant: {
              details: {
                air_temperature: 6,
                air_pressure_at_sea_level: 1010,
                cloud_area_fraction: 90,
                relative_humidity: 70,
                wind_from_direction: 90,
                wind_speed: 3,
              },
            },
            next_6_hours: {
              summary: { symbol_code: "heavysnow_night" },
              details: { precipitation_amount: 2, air_temperature_min: 1, air_temperature_max: 8 },
            },
          },
        },
      ],
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

describe("MET Norway weather provider", () => {
  it("registers with the expected id and priority", () => {
    const provider = getProvider();
    expect(provider.id).toBe("met-norway");
    expect(provider.priority).toBe(8);
  });

  it("maps current weather, preferring the next_1_hours symbol and precipitation", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));

    const res = await getProvider().getCurrentWeather(COORDS);

    expect(res.source).toBe("met-norway");
    expect(res.location).toEqual(COORDS);
    expect(res.current).toMatchObject({
      temperature: 10,
      feelsLike: 10,
      humidity: 60,
      pressure: 1015,
      windDirection: 180,
      precipitation: 0,
      cloudCover: 12,
      // clearsky_day -> WMO 0, _day suffix -> isDay true
      weatherCode: 0,
      isDay: true,
      time: "2026-03-10T10:00:00Z",
    });
    // metric wind: m/s -> km/h (5 * 3.6), gust 9 * 3.6
    expect(res.current.windSpeed).toBeCloseTo(18, 5);
    expect(res.current.windGusts).toBeCloseTo(32.4, 5);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("lat=59.9139&lon=10.7522");
  });

  it("converts to imperial units (temp Fahrenheit, wind mph)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));

    const res = await getProvider().getCurrentWeather(COORDS, { units: "imperial" });

    // 10C -> 50F
    expect(res.current.temperature).toBeCloseTo(50, 5);
    expect(res.current.feelsLike).toBeCloseTo(50, 5);
    // 5 m/s -> mph (5 * 2.237)
    expect(res.current.windSpeed).toBeCloseTo(11.185, 5);
    expect(res.current.windGusts).toBeCloseTo(20.133, 3);
  });

  it("falls back to next_6_hours symbol then 'cloudy', and maps unknown symbols to WMO 3", async () => {
    const data = sampleResponse();
    // Strip next_1_hours so getBestSymbol falls through to next_6_hours ("cloudy" -> 3).
    delete (data.properties.timeseries[0].data as Record<string, unknown>).next_1_hours;
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const res = await getProvider().getCurrentWeather(COORDS);
    expect(res.current.weatherCode).toBe(3);
  });

  it("strips _night suffix and reports isDay false", async () => {
    const data = sampleResponse();
    data.properties.timeseries[0].data.next_1_hours = {
      summary: { symbol_code: "partlycloudy_night" },
      details: { precipitation_amount: 0, probability_of_precipitation: 0 },
    };
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const res = await getProvider().getCurrentWeather(COORDS);
    // partlycloudy -> WMO 2
    expect(res.current.weatherCode).toBe(2);
    expect(res.current.isDay).toBe(false);
  });

  it("builds hourly points only from entries that have next_1_hours", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));

    const hourly = await getProvider().getHourlyForecast(COORDS, 24);

    // Only the first two entries carry next_1_hours; the third (next_6_hours only) is skipped.
    expect(hourly).toHaveLength(2);
    expect(hourly[0]).toMatchObject({
      time: "2026-03-10T10:00:00Z",
      temperature: 10,
      weatherCode: 0,
      precipitationProbability: 5,
      precipitation: 0,
      windDirection: 180,
      cloudCover: 12,
      pressure: 1015,
    });
    expect(hourly[0]?.windSpeed).toBeCloseTo(18, 5);
    expect(hourly[1]?.weatherCode).toBe(61); // lightrain -> 61
  });

  it("respects the requested hour limit", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));
    const hourly = await getProvider().getHourlyForecast(COORDS, 1);
    expect(hourly).toHaveLength(1);
  });

  it("aggregates daily min/max temps, precipitation sum, and a midday symbol", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));

    const daily = await getProvider().getDailyForecast(COORDS, 7);

    expect(daily).toHaveLength(2);
    const day1 = daily[0];
    expect(day1?.date).toBe("2026-03-10");
    expect(day1?.temperatureMin).toBe(10);
    expect(day1?.temperatureMax).toBe(14);
    // precip sum from next_1_hours entries: 0 + 0.4
    expect(day1?.precipitationSum).toBeCloseTo(0.4, 5);
    // midday entry (T12:) uses lightrain -> 61
    expect(day1?.weatherCode).toBe(61);
    // maxWind 7 m/s -> 25.2 km/h
    expect(day1?.windSpeedMax).toBeCloseTo(25.2, 5);

    // Day 2 widens its min/max from next_6_hours air_temperature_min/max.
    const day2 = daily[1];
    expect(day2?.date).toBe("2026-03-11");
    expect(day2?.temperatureMin).toBe(1);
    expect(day2?.temperatureMax).toBe(8);
    // heavysnow_night -> 75
    expect(day2?.weatherCode).toBe(75);
  });

  it("throws when the timeseries is empty", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ properties: { meta: { updated_at: "" }, timeseries: [] } }),
    );
    await expect(getProvider().getCurrentWeather(COORDS)).rejects.toThrow(
      "No timeseries data from MET Norway",
    );
  });
});
