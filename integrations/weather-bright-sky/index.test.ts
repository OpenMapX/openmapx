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
    throw new Error("Bright Sky provider was not registered with forecast methods");
  }
  return provider as LoadedWeatherProvider;
}

function currentResponse() {
  return {
    weather: {
      timestamp: "2026-03-10T10:00:00+00:00",
      cloud_cover: 30,
      icon: "rain",
      precipitation_10: 0.2,
      pressure_msl: 1013,
      relative_humidity: 78,
      temperature: 9,
      wind_direction_10: 210,
      wind_gust_speed_10: 40,
      wind_speed_10: 18,
    },
  };
}

function hourlyResponse() {
  return {
    weather: [
      {
        timestamp: "2026-03-10T10:00:00+00:00",
        cloud_cover: 20,
        icon: "clear-day",
        precipitation: 0,
        precipitation_probability: 5,
        pressure_msl: 1015,
        relative_humidity: 60,
        temperature: 10,
        wind_direction: 180,
        wind_speed: 16,
      },
      {
        timestamp: "2026-03-10T12:00:00+00:00",
        cloud_cover: 80,
        icon: "rain",
        precipitation: 1.2,
        precipitation_probability: 70,
        pressure_msl: 1012,
        relative_humidity: 85,
        temperature: 12,
        wind_direction: 200,
        wind_speed: 25,
      },
      {
        timestamp: "2026-03-11T12:00:00+00:00",
        cloud_cover: 50,
        icon: "snow",
        precipitation: 0.5,
        precipitation_probability: 40,
        pressure_msl: 1008,
        relative_humidity: 90,
        temperature: 2,
        wind_direction: 90,
        wind_speed: 10,
      },
    ],
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

describe("Bright Sky weather provider", () => {
  it("registers with id and priority", () => {
    const provider = getProvider();
    expect(provider.id).toBe("bright-sky");
    expect(provider.priority).toBe(3);
  });

  it("maps current weather and keeps km/h wind for metric", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));

    const res = await getProvider().getCurrentWeather(COORDS);

    expect(res.source).toBe("bright-sky");
    expect(res.location).toEqual(COORDS);
    expect(res.current).toMatchObject({
      temperature: 9,
      feelsLike: 9,
      humidity: 78,
      pressure: 1013,
      windSpeed: 18, // km/h passthrough
      windDirection: 210,
      windGusts: 40,
      precipitation: 0.2,
      cloudCover: 30,
      weatherCode: 63, // icon "rain" -> 63
      isDay: true,
      time: "2026-03-10T10:00:00+00:00",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/current_weather?lat=52.52&lon=13.405");
  });

  it("converts to imperial (Fahrenheit temps, mph wind via /1.609)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));

    const res = await getProvider().getCurrentWeather(COORDS, { units: "imperial" });

    expect(res.current.temperature).toBeCloseTo(48.2, 5); // 9C -> 48.2F
    expect(res.current.windSpeed).toBeCloseTo(18 / 1.609, 5);
    expect(res.current.windGusts).toBeCloseTo(40 / 1.609, 5);
  });

  it("falls back to cloud-cover thresholds when the icon is unknown", async () => {
    const lowCloud = currentResponse();
    lowCloud.weather.icon = null as unknown as string;
    lowCloud.weather.cloud_cover = 10; // < 25 -> clear (0)
    mockFetch.mockResolvedValueOnce(mockOk(lowCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(0);

    const midCloud = currentResponse();
    midCloud.weather.icon = null as unknown as string;
    midCloud.weather.cloud_cover = 50; // 25..75 -> partly cloudy (2)
    mockFetch.mockResolvedValueOnce(mockOk(midCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(2);

    const highCloud = currentResponse();
    highCloud.weather.icon = null as unknown as string;
    highCloud.weather.cloud_cover = 90; // >= 75 -> cloudy (3)
    mockFetch.mockResolvedValueOnce(mockOk(highCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(3);
  });

  it("treats *-night icons as night-time", async () => {
    const data = currentResponse();
    data.weather.icon = "partly-cloudy-night";
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const res = await getProvider().getCurrentWeather(COORDS);
    expect(res.current.isDay).toBe(false);
    expect(res.current.weatherCode).toBe(2); // partly-cloudy-night -> 2
  });

  it("throws when current data is missing (outside Germany)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ weather: { temperature: null } }));
    await expect(getProvider().getCurrentWeather(COORDS)).rejects.toThrow("No Bright Sky data");
  });

  it("maps hourly forecast points and clamps to the requested hours", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(hourlyResponse()));

    const hourly = await getProvider().getHourlyForecast(COORDS, 2);

    expect(hourly).toHaveLength(2);
    expect(hourly[0]).toMatchObject({
      time: "2026-03-10T10:00:00+00:00",
      temperature: 10,
      weatherCode: 0, // clear-day -> 0
      precipitationProbability: 5,
      precipitation: 0,
      windSpeed: 16,
      windDirection: 180,
      cloudCover: 20,
      pressure: 1015,
    });
    expect(hourly[1]?.weatherCode).toBe(63); // rain -> 63
  });

  it("throws when no hourly forecast rows are returned", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ weather: [] }));
    await expect(getProvider().getHourlyForecast(COORDS, 12)).rejects.toThrow(
      "No forecast data from Bright Sky",
    );
  });

  it("aggregates daily summaries from hourly rows with a midday symbol", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(hourlyResponse()));

    const daily = await getProvider().getDailyForecast(COORDS, 7);

    expect(daily).toHaveLength(2);
    const day1 = daily[0];
    expect(day1?.date).toBe("2026-03-10");
    expect(day1?.temperatureMin).toBe(10);
    expect(day1?.temperatureMax).toBe(12);
    expect(day1?.precipitationSum).toBeCloseTo(1.2, 5);
    expect(day1?.windSpeedMax).toBe(25);
    // midday (T12:) row uses icon "rain" -> 63
    expect(day1?.weatherCode).toBe(63);

    const day2 = daily[1];
    expect(day2?.date).toBe("2026-03-11");
    expect(day2?.weatherCode).toBe(73); // snow -> 73
  });
});
