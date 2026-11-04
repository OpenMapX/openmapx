import type { LngLat } from "@openmapx/core";
import type { WeatherProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { owmIdToWmo, setup } from "./index.js";

const COORDS: LngLat = [13.405, 52.52];

function mockOk(data: unknown) {
  return Response.json(data);
}

type LoadedWeatherProvider = WeatherProvider &
  Required<Pick<WeatherProvider, "getHourlyForecast" | "getDailyForecast">>;

function getProvider(
  config: Record<string, unknown> = { apiKey: "test-owm-key" },
): LoadedWeatherProvider {
  const ctx = createMockIntegrationContext({ config });
  setup(ctx);
  const provider = ctx.registered.weather[0];
  if (!provider?.getHourlyForecast || !provider.getDailyForecast) {
    throw new Error("OpenWeatherMap provider was not registered with forecast methods");
  }
  return provider as LoadedWeatherProvider;
}

function currentResponse() {
  return {
    dt: 1_741_600_800, // 2025-03-10T10:00:00Z
    main: { temp: 8.4, feels_like: 6.1, humidity: 72, pressure: 1012 },
    wind: { speed: 4, deg: 220, gust: 7 },
    clouds: { all: 40 },
    weather: [{ id: 500, icon: "10d" }],
    rain: { "1h": 0.5 },
    sys: { sunrise: 1_741_584_000, sunset: 1_741_624_800 },
  };
}

function forecastResponse() {
  return {
    list: [
      {
        dt: 1_741_600_800,
        main: { temp: 8, feels_like: 6, humidity: 70, pressure: 1010 },
        wind: { speed: 5, deg: 200, gust: 8 },
        clouds: { all: 50 },
        weather: [{ id: 803 }],
        pop: 0.4,
        rain: { "3h": 0.6 },
        dt_txt: "2025-03-10 10:00:00",
      },
      {
        dt: 1_741_611_600,
        main: { temp: 12, feels_like: 11, humidity: 60, pressure: 1009 },
        wind: { speed: 3, deg: 210, gust: 6 },
        clouds: { all: 20 },
        weather: [{ id: 800 }],
        pop: 0.1,
        dt_txt: "2025-03-10 13:00:00",
      },
      {
        dt: 1_741_687_200, // next day
        main: { temp: 5, feels_like: 3, humidity: 80, pressure: 1005 },
        wind: { speed: 6, deg: 180, gust: 10 },
        clouds: { all: 90 },
        weather: [{ id: 601 }],
        pop: 0.8,
        snow: { "3h": 2 },
        dt_txt: "2025-03-11 10:00:00",
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

describe("owmIdToWmo condition mapping", () => {
  it.each([
    [210, 96], // thunderstorm without rain
    [230, 95], // thunderstorm with drizzle (id >= 230)
    [300, 51], // light drizzle (id <= 311)
    [321, 55], // heavier drizzle
    [500, 61], // light rain
    [501, 63], // moderate rain
    [502, 65], // heavy rain
    [503, 65],
    [511, 66], // freezing rain
    [520, 80], // shower rain
    [504, 61], // extreme rain falls through to 61
    [600, 71], // light snow
    [601, 73], // snow
    [602, 75], // heavy snow
    [611, 85], // sleet
    [615, 85], // light rain and snow (id >= 611)
    [603, 71], // unlisted snow id falls through to 71
    [701, 45], // mist/atmosphere
    [762, 45], // ash
    [800, 0], // clear
    [801, 1], // few clouds
    [802, 2], // scattered clouds
    [803, 3], // broken clouds
    [804, 3], // overcast
    [999, 0], // unknown -> clear default
  ])("maps OWM id %i to WMO code %i", (id, expected) => {
    expect(owmIdToWmo(id)).toBe(expected);
  });
});

describe("OpenWeatherMap weather provider", () => {
  it("does not register when no apiKey is configured", () => {
    const ctx = createMockIntegrationContext({ config: {} });
    setup(ctx);
    expect(ctx.registered.weather).toHaveLength(0);
  });

  it("registers with id and priority when an apiKey is present", () => {
    const provider = getProvider();
    expect(provider.id).toBe("openweathermap");
    expect(provider.priority).toBe(5);
  });

  it("maps current weather and sums rain+snow precipitation", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));

    const res = await getProvider().getCurrentWeather(COORDS);

    expect(res.source).toBe("openweathermap");
    expect(res.location).toEqual(COORDS);
    expect(res.current).toMatchObject({
      temperature: 8.4,
      feelsLike: 6.1,
      humidity: 72,
      pressure: 1012,
      windDirection: 220,
      precipitation: 0.5,
      cloudCover: 40,
      weatherCode: 61, // id 500 -> 61
      isDay: true, // dt is between sunrise and sunset
      time: "2025-03-10T10:00:00.000Z",
    });
    // metric: m/s -> km/h (4 * 3.6, gust 7 * 3.6)
    expect(res.current.windSpeed).toBeCloseTo(14.4, 5);
    expect(res.current.windGusts).toBeCloseTo(25.2, 5);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/weather?lat=52.52&lon=13.405");
    expect(url).toContain("appid=test-owm-key");
    expect(url).toContain("units=metric");
  });

  it("keeps wind unscaled for imperial and forwards units in the URL", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(currentResponse()));

    const res = await getProvider().getCurrentWeather(COORDS, { units: "imperial" });

    // OWM returns the requested units already; imperial wind is mph (multiplier 1).
    expect(res.current.windSpeed).toBe(4);
    expect(res.current.windGusts).toBe(7);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("units=imperial");
  });

  it("derives isDay from the icon suffix when sunrise/sunset are absent", async () => {
    const data = currentResponse();
    data.sys = { sunrise: 0, sunset: 0 };
    data.weather = [{ id: 803, icon: "04n" }];
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const res = await getProvider().getCurrentWeather(COORDS);
    expect(res.current.isDay).toBe(false);
  });

  it("maps hourly forecast steps with rounded precipitation probability", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(forecastResponse()));

    const hourly = await getProvider().getHourlyForecast(COORDS, 9);
    expect(hourly.source).toBe("openweathermap");

    expect(hourly.points).toHaveLength(3);
    expect(hourly.points[0]).toMatchObject({
      time: "2025-03-10T10:00:00.000Z",
      temperature: 8,
      weatherCode: 3, // id 803 -> 3
      precipitationProbability: 40, // 0.4 -> 40
      precipitation: 0.6,
      windDirection: 200,
      cloudCover: 50,
      pressure: 1010,
    });
    expect(hourly.points[0]?.windSpeed).toBeCloseTo(18, 5); // 5 m/s -> km/h
    // snow-only entry uses the 3h snow accumulation.
    expect(hourly.points[2]?.precipitation).toBe(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/forecast?");
  });

  it("aggregates daily summaries using the highest-pop dominant code", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(forecastResponse()));

    const daily = await getProvider().getDailyForecast(COORDS, 7);
    expect(daily.source).toBe("openweathermap");

    expect(daily.points).toHaveLength(2);
    const day1 = daily.points[0];
    expect(day1?.date).toBe("2025-03-10");
    expect(day1?.temperatureMin).toBe(8);
    expect(day1?.temperatureMax).toBe(12);
    expect(day1?.precipitationSum).toBeCloseTo(0.6, 5);
    expect(day1?.windSpeedMax).toBeCloseTo(18, 5); // max(5,3) m/s -> km/h
    // pop 0.4 (id 803) beats pop 0.1 (id 800) -> dominant code 803 -> WMO 3
    expect(day1?.weatherCode).toBe(3);

    const day2 = daily.points[1];
    expect(day2?.date).toBe("2025-03-11");
    expect(day2?.weatherCode).toBe(73); // id 601 -> 73
  });

  it("groups days by the local date at the location, not the UTC date", async () => {
    // Auckland is UTC+13: its 1 November runs 2026-10-31T11:00Z..2026-11-01T10:59Z.
    const entry = (iso: string, temp: number, rain3h = 0) => ({
      dt: Date.parse(iso) / 1000,
      main: { temp, feels_like: temp, humidity: 70, pressure: 1012 },
      wind: { speed: 4, deg: 180 },
      clouds: { all: 60 },
      weather: [{ id: 803 }],
      pop: 0.2,
      rain: { "3h": rain3h },
      dt_txt: iso.slice(0, 19).replace("T", " "),
    });
    mockFetch.mockResolvedValueOnce(
      mockOk({
        list: [
          entry("2026-10-31T09:00:00Z", 25, 5), // 22:00 local on 31 October
          entry("2026-10-31T12:00:00Z", 9, 1), // 01:00 local on 1 November
          entry("2026-10-31T18:00:00Z", 6),
          entry("2026-11-01T00:00:00Z", 17),
          entry("2026-11-01T09:00:00Z", 12, 2), // 22:00 local
          entry("2026-11-01T12:00:00Z", 3, 7), // 01:00 local on 2 November
        ],
      }),
    );

    const daily = await getProvider().getDailyForecast([174.7633, -36.8485], 7);

    expect(daily.points.map((p) => [p.date, p.timeZone])).toEqual([
      ["2026-10-31", "Pacific/Auckland"],
      ["2026-11-01", "Pacific/Auckland"],
      ["2026-11-02", "Pacific/Auckland"],
    ]);
    const day = daily.points[1];
    expect(day?.temperatureMin).toBe(6);
    expect(day?.temperatureMax).toBe(17);
    expect(day?.precipitationSum).toBeCloseTo(3, 5);
  });
});
