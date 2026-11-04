import { isoWithOffsetInZone, type LngLat } from "@openmapx/core";
import type { WeatherProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brightSkyWeatherCode, setup } from "./index.js";

const COORDS: LngLat = [13.405, 52.52];
const NEW_YORK: LngLat = [-74.006, 40.7128];

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
      condition: "rain" as string | null,
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
      humidity: 78,
      pressure: 1013,
      windSpeed: 18, // km/h passthrough
      windDirection: 210,
      windGusts: 40,
      precipitation: 0.2,
      cloudCover: 30,
      // 0.2 mm in 10 minutes is 1.2 mm/h: slight rain.
      weatherCode: 61,
      isDay: true,
      time: "2026-03-10T10:00:00+00:00",
    });
    expect(res.current).not.toHaveProperty("feelsLike");
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
    lowCloud.weather.condition = null;
    lowCloud.weather.icon = null as unknown as string;
    lowCloud.weather.cloud_cover = 10; // < 25 -> clear (0)
    mockFetch.mockResolvedValueOnce(mockOk(lowCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(0);

    const midCloud = currentResponse();
    midCloud.weather.condition = null;
    midCloud.weather.icon = null as unknown as string;
    midCloud.weather.cloud_cover = 50; // 25..75 -> partly cloudy (2)
    mockFetch.mockResolvedValueOnce(mockOk(midCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(2);

    const highCloud = currentResponse();
    highCloud.weather.condition = null;
    highCloud.weather.icon = null as unknown as string;
    highCloud.weather.cloud_cover = 90; // >= 75 -> cloudy (3)
    mockFetch.mockResolvedValueOnce(mockOk(highCloud));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(3);
  });

  it("treats *-night icons as night-time", async () => {
    const data = currentResponse();
    data.weather.condition = "dry";
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
    expect(hourly.source).toBe("bright-sky");

    expect(hourly.points).toHaveLength(2);
    expect(hourly.points[0]).toMatchObject({
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
    expect(hourly.points[1]?.weatherCode).toBe(61); // 1.2 mm in the hour: slight rain
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
    expect(daily.source).toBe("bright-sky");

    expect(daily.points).toHaveLength(2);
    const day1 = daily.points[0];
    expect(day1?.date).toBe("2026-03-10");
    expect(day1?.temperatureMin).toBe(10);
    expect(day1?.temperatureMax).toBe(12);
    expect(day1?.precipitationSum).toBeCloseTo(1.2, 5);
    expect(day1?.windSpeedMax).toBe(25);
    // The midday (T12:) row states rain at 1.2 mm/h: slight rain.
    expect(day1?.weatherCode).toBe(61);

    const day2 = daily.points[1];
    expect(day2?.date).toBe("2026-03-11");
    expect(day2?.weatherCode).toBe(71); // 0.5 mm in the hour: slight snowfall
  });

  it("groups days by the local date at the location, across a DST change", async () => {
    // New York leaves EDT for EST at 02:00 local on 1 November 2026, so that
    // local day has 25 hours: 04:00Z on 1 November to 04:00Z on 2 November.
    const first = Date.parse("2026-11-01T03:00:00Z");
    const rows = Array.from({ length: 27 }, (_, i) => {
      const at = first + i * 60 * 60 * 1000;
      return {
        at,
        cloud_cover: 90,
        condition: "dry" as string | null,
        icon: "cloudy" as string | null,
        precipitation: 0,
        precipitation_probability: 0,
        pressure_msl: 1015,
        relative_humidity: 70,
        temperature: 10,
        wind_direction: 180,
        wind_speed: 10,
      };
    });
    const at = (iso: string) => {
      const row = rows.find((r) => r.at === Date.parse(iso));
      if (!row) throw new Error(`no row at ${iso}`);
      return row;
    };
    // 23:00 local on 31 October.
    Object.assign(at("2026-11-01T03:00:00Z"), { temperature: -5 });
    // 07:00 local, which a UTC "T12:" match would pick as the day's symbol.
    Object.assign(at("2026-11-01T12:00:00Z"), {
      condition: "rain",
      icon: "rain",
      precipitation: 8,
    });
    // 12:00 EST, local noon.
    Object.assign(at("2026-11-01T17:00:00Z"), { icon: "clear-day", cloud_cover: 5 });
    // 22:00 local on 1 November.
    Object.assign(at("2026-11-02T03:00:00Z"), {
      temperature: 15,
      precipitation: 3,
      wind_speed: 30,
    });
    // 00:00 local on 2 November.
    Object.assign(at("2026-11-02T05:00:00Z"), { temperature: 20 });

    // Bright Sky renders timestamps in the requested `tz`, UTC by default.
    mockFetch.mockImplementation(async (url: string) => {
      const tz = new URL(String(url)).searchParams.get("tz") ?? "UTC";
      return mockOk({
        weather: rows.map(({ at, ...row }) => ({
          ...row,
          timestamp: isoWithOffsetInZone(new Date(at), tz),
        })),
      });
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:30 EDT on 31 October.
    vi.setSystemTime(new Date("2026-11-01T03:30:00Z"));
    try {
      const daily = await getProvider().getDailyForecast(NEW_YORK, 3);

      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(url.searchParams.get("tz")).toBe("America/New_York");
      expect(url.searchParams.get("date")).toBe("2026-10-31");
      expect(url.searchParams.get("last_date")).toBe("2026-11-03");

      expect(daily.points.map((p) => p.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
      expect(daily.points.every((p) => p.timeZone === "America/New_York")).toBe(true);
      const day = daily.points[1];
      expect(day?.temperatureMin).toBe(10);
      expect(day?.temperatureMax).toBe(15);
      expect(day?.precipitationSum).toBe(11);
      expect(day?.windSpeedMax).toBe(30);
      expect(day?.weatherCode).toBe(0);
      expect(daily.points[0]?.temperatureMin).toBe(-5);
      expect(daily.points[2]?.temperatureMax).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits current readings Bright Sky does not report instead of showing zero", async () => {
    const data = currentResponse();
    Object.assign(data.weather, {
      cloud_cover: null,
      precipitation_10: null,
      pressure_msl: null,
      relative_humidity: null,
      wind_direction_10: null,
      wind_gust_speed_10: null,
      wind_speed_10: null,
    });
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const { current } = await getProvider().getCurrentWeather(COORDS, { units: "imperial" });

    expect(current.temperature).toBeCloseTo(48.2, 5);
    for (const field of [
      "feelsLike",
      "humidity",
      "pressure",
      "precipitation",
      "cloudCover",
      "windSpeed",
      "windDirection",
      "windGusts",
    ] as const) {
      expect(current[field], field).toBeUndefined();
    }
  });

  it("grades current precipitation from the 10-minute amount as an hourly rate", async () => {
    const graded = async (precipitation10: number) => {
      const data = currentResponse();
      data.weather.precipitation_10 = precipitation10;
      mockFetch.mockResolvedValueOnce(mockOk(data));
      return (await getProvider().getCurrentWeather(COORDS)).current.weatherCode;
    };
    expect(await graded(0.4)).toBe(61); // 2.4 mm/h
    expect(await graded(0.5)).toBe(63); // 3 mm/h
    expect(await graded(1.3)).toBe(65); // 7.8 mm/h
  });
});

describe("Bright Sky weather code", () => {
  const record = (
    condition: string | null,
    icon: string | null,
    cloud_cover: number | null = 50,
  ) => ({
    condition,
    icon,
    cloud_cover,
  });

  it.each([
    ["rain", 0.1, 61],
    ["rain", 2.49, 61],
    ["rain", 2.5, 63],
    ["rain", 7.59, 63],
    ["rain", 7.6, 65],
    ["snow", 1, 71],
    ["snow", 3, 73],
    ["snow", 8, 75],
    ["sleet", 1, 68],
    ["sleet", 3, 69],
    ["sleet", 8, 69],
    ["hail", 1, 89],
    ["hail", 3, 90],
    ["hail", 8, 90],
    ["thunderstorm", 10, 95],
    ["fog", 0, 45],
  ])("grades %s at %f mm/h as WMO %i", (condition, rate, code) => {
    expect(brightSkyWeatherCode(record(condition, condition), rate)).toBe(code);
    expect(brightSkyWeatherCode(record(null, condition), rate)).toBe(code);
  });

  it.each([
    ["rain", 61],
    ["snow", 71],
    ["sleet", 68],
    ["hail", 89],
  ])("claims only the light %s code when the amount is unknown", (condition, code) => {
    expect(brightSkyWeatherCode(record(condition, condition), null)).toBe(code);
  });

  it("reports the stated precipitation type even when the icon shows only clouds", () => {
    // Bright Sky draws a precipitation icon only above 0.5 mm; the condition still states snow.
    expect(brightSkyWeatherCode(record("snow", "cloudy", 90), 0.3)).toBe(71);
  });

  it.each([
    [90, 3],
    [75, 3],
    [50, 2],
    [25, 2],
    [10, 0],
  ])("classifies the measured %i%% cloud cover behind a wind icon as WMO %i", (cover, code) => {
    expect(brightSkyWeatherCode(record("dry", "wind", cover), 0)).toBe(code);
  });

  it.each([
    ["clear-day", 0],
    ["clear-night", 0],
    ["partly-cloudy-day", 2],
    ["partly-cloudy-night", 2],
    ["cloudy", 3],
  ])("maps the dry %s icon to WMO %i", (icon, code) => {
    expect(brightSkyWeatherCode(record("dry", icon), 0)).toBe(code);
  });
});
