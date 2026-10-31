import type { LngLat } from "@openmapx/core";
import { weatherCodeToDescription } from "@openmapx/core";
import type { WeatherProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMetSymbol, SYMBOL_TO_WMO, setup } from "./index.js";

const COORDS: LngLat = [10.7522, 59.9139];
const AUCKLAND: LngLat = [174.7633, -36.8485];
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
    // MET's compact forecast has no apparent temperature.
    expect(res.current).not.toHaveProperty("feelsLike");
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
    // 5 m/s -> mph (5 * 2.237)
    expect(res.current.windSpeed).toBeCloseTo(11.185, 5);
    expect(res.current.windGusts).toBeCloseTo(20.133, 3);
  });

  it("falls back to the next_6_hours symbol without reporting its 6-hour total as current", async () => {
    const data = sampleResponse();
    delete (data.properties.timeseries[0].data as Record<string, unknown>).next_1_hours;
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const res = await getProvider().getCurrentWeather(COORDS);
    expect(res.current.weatherCode).toBe(3); // next_6_hours "cloudy"
    expect(res.current.precipitation).toBeUndefined();
  });

  it("classifies the forecast cloud cover when the symbol is unknown or absent", async () => {
    const unknown = sampleResponse();
    unknown.properties.timeseries[0].data.next_1_hours = {
      summary: { symbol_code: "unlisted_day" },
      details: { precipitation_amount: 0, probability_of_precipitation: 0 },
    };
    mockFetch.mockResolvedValueOnce(mockOk(unknown));
    // cloud_area_fraction 12 -> clear
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(0);

    const absent = sampleResponse();
    const first = absent.properties.timeseries[0].data as Record<string, unknown>;
    delete first.next_1_hours;
    delete first.next_6_hours;
    absent.properties.timeseries[0].data.instant.details.cloud_area_fraction = 50;
    mockFetch.mockResolvedValueOnce(mockOk(absent));
    expect((await getProvider().getCurrentWeather(COORDS)).current.weatherCode).toBe(2);
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
    expect(hourly.source).toBe("met-norway");

    // Only the first two entries carry next_1_hours; the third (next_6_hours only) is skipped.
    expect(hourly.points).toHaveLength(2);
    expect(hourly.points[0]).toMatchObject({
      time: "2026-03-10T10:00:00Z",
      temperature: 10,
      weatherCode: 0,
      precipitationProbability: 5,
      precipitation: 0,
      windDirection: 180,
      cloudCover: 12,
      pressure: 1015,
    });
    expect(hourly.points[0]?.windSpeed).toBeCloseTo(18, 5);
    expect(hourly.points[1]?.weatherCode).toBe(61); // lightrain -> 61
  });

  it("respects the requested hour limit", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));
    const hourly = await getProvider().getHourlyForecast(COORDS, 1);
    expect(hourly.source).toBe("met-norway");
    expect(hourly.points).toHaveLength(1);
  });

  it("aggregates daily min/max temps, precipitation sum, and a midday symbol", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(sampleResponse()));

    const daily = await getProvider().getDailyForecast(COORDS, 7);
    expect(daily.source).toBe("met-norway");

    expect(daily.points).toHaveLength(2);
    const day1 = daily.points[0];
    expect(day1?.date).toBe("2026-03-10");
    expect(day1?.temperatureMin).toBe(10);
    expect(day1?.temperatureMax).toBe(14);
    // 10:00 and 12:00 hours: 0 + 0.4; the overlapping 10:00 6-hour total is not added.
    expect(day1?.precipitationSum).toBeCloseTo(0.4, 5);
    // midday entry (T12:) uses lightrain -> 61
    expect(day1?.weatherCode).toBe(61);
    // maxWind 7 m/s -> 25.2 km/h
    expect(day1?.windSpeedMax).toBeCloseTo(25.2, 5);

    // Day 2 widens its min/max from next_6_hours air_temperature_min/max.
    const day2 = daily.points[1];
    expect(day2?.date).toBe("2026-03-11");
    expect(day2?.temperatureMin).toBe(1);
    expect(day2?.temperatureMax).toBe(8);
    // heavysnow_night -> 75
    expect(day2?.weatherCode).toBe(75);
    // A 6-hourly step carries its amount only in next_6_hours.
    expect(day2?.precipitationSum).toBeCloseTo(2, 5);
  });

  it("throws when the timeseries is empty", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ properties: { meta: { updated_at: "" }, timeseries: [] } }),
    );
    await expect(getProvider().getCurrentWeather(COORDS)).rejects.toThrow(
      "No timeseries data from MET Norway",
    );
  });

  it("sums a day's hourly steps and the 6-hourly steps after them without double counting", async () => {
    const step = (time: string, oneHour: number | null, sixHours: number) => ({
      time,
      data: {
        instant: {
          details: {
            air_temperature: 5,
            air_pressure_at_sea_level: 1010,
            cloud_area_fraction: 90,
            relative_humidity: 80,
            wind_from_direction: 0,
            wind_speed: 2,
          },
        },
        ...(oneHour == null
          ? {}
          : {
              next_1_hours: {
                summary: { symbol_code: "rain" },
                details: { precipitation_amount: oneHour },
              },
            }),
        next_6_hours: {
          summary: { symbol_code: "rain" },
          details: { precipitation_amount: sixHours },
        },
      },
    });
    const timeseries = [
      ...[14, 15, 16, 17].map((hour) => step(`2026-03-10T${hour}:00:00Z`, 1, 9)),
      step("2026-03-10T18:00:00Z", null, 3),
      step("2026-03-11T00:00:00Z", null, 4),
      step("2026-03-11T06:00:00Z", null, 5),
    ];
    mockFetch.mockResolvedValueOnce(
      mockOk({ properties: { meta: { updated_at: "" }, timeseries } }),
    );

    const daily = await getProvider().getDailyForecast(COORDS, 7);

    expect(daily.points.map((p) => [p.date, p.precipitationSum])).toEqual([
      ["2026-03-10", 7],
      ["2026-03-11", 9],
    ]);
  });

  describe("local days", () => {
    const HOUR_MS = 60 * 60 * 1000;

    function metStep(
      time: string,
      options: {
        temperature?: number;
        wind?: number;
        symbol?: string;
        oneHour?: number | null;
        sixHours?: number;
      },
    ) {
      const { temperature = 15, wind = 3, symbol = "cloudy", oneHour = 0, sixHours = 0 } = options;
      return {
        time,
        data: {
          instant: {
            details: {
              air_temperature: temperature,
              air_pressure_at_sea_level: 1012,
              cloud_area_fraction: 90,
              relative_humidity: 70,
              wind_from_direction: 180,
              wind_speed: wind,
            },
          },
          ...(oneHour == null
            ? {}
            : {
                next_1_hours: {
                  summary: { symbol_code: symbol },
                  details: { precipitation_amount: oneHour },
                },
              }),
          next_6_hours: {
            summary: { symbol_code: symbol },
            details: { precipitation_amount: sixHours },
          },
        },
      };
    }

    function hourlyTimes(firstIso: string, count: number): string[] {
      const first = Date.parse(firstIso);
      return Array.from({ length: count }, (_, i) =>
        new Date(first + i * HOUR_MS).toISOString().replace(".000Z", "Z"),
      );
    }

    it("groups Auckland's forecast by its local date, not the UTC date", async () => {
      // Auckland is UTC+13: its 1 November runs 2026-10-31T11:00Z..2026-11-01T10:00Z.
      const special: Record<string, Parameters<typeof metStep>[1]> = {
        // 23:00 local on 31 October.
        "2026-10-31T10:00:00Z": { temperature: 30 },
        // 03:00 and 06:00 local on 1 November, which are 31 October in UTC.
        "2026-10-31T14:00:00Z": { oneHour: 1 },
        "2026-10-31T17:00:00Z": { temperature: 7 },
        // Local noon.
        "2026-10-31T23:00:00Z": { symbol: "clearsky_day" },
        // 20:00 local.
        "2026-11-01T07:00:00Z": { oneHour: 0.5 },
      };
      const timeseries = [
        ...hourlyTimes("2026-10-31T10:00:00Z", 26).map((time) =>
          metStep(time, special[time] ?? {}),
        ),
        // 01:00 local on 2 November, which a UTC "T12:" match would take as 1 November's symbol.
        metStep("2026-11-01T12:00:00Z", {
          oneHour: null,
          sixHours: 4,
          wind: 20,
          symbol: "heavyrain",
        }),
        metStep("2026-11-01T18:00:00Z", { oneHour: null, sixHours: 2 }),
      ];
      mockFetch.mockResolvedValueOnce(
        mockOk({ properties: { meta: { updated_at: "" }, timeseries } }),
      );

      const daily = await getProvider().getDailyForecast(AUCKLAND, 7);

      expect(daily.points.map((p) => p.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
      expect(daily.points.every((p) => p.timeZone === "Pacific/Auckland")).toBe(true);
      const day = daily.points[1];
      expect(day?.temperatureMin).toBe(7);
      expect(day?.temperatureMax).toBe(15);
      expect(day?.precipitationSum).toBeCloseTo(1.5, 5);
      expect(day?.windSpeedMax).toBeCloseTo(10.8, 5);
      expect(day?.weatherCode).toBe(0);
      expect(daily.points[0]?.temperatureMax).toBe(30);
      expect(daily.points[2]?.precipitationSum).toBeCloseTo(6, 5);
    });

    it("keeps all 25 hours of New York's day on which daylight saving time ends", async () => {
      // EDT (UTC-4) gives way to EST (UTC-5) at 02:00 local on 1 November 2026.
      const timeseries = hourlyTimes("2026-11-01T04:00:00Z", 26).map((time) =>
        metStep(time, {
          oneHour: 0.1,
          // 07:00 local is 12:00 UTC; local noon is 17:00 UTC.
          symbol:
            time === "2026-11-01T17:00:00Z"
              ? "fair_day"
              : time === "2026-11-01T12:00:00Z"
                ? "rain"
                : "cloudy",
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({ properties: { meta: { updated_at: "" }, timeseries } }),
      );

      const daily = await getProvider().getDailyForecast(NEW_YORK, 7);

      expect(daily.points.map((p) => [p.date, p.timeZone])).toEqual([
        ["2026-11-01", "America/New_York"],
        ["2026-11-02", "America/New_York"],
      ]);
      expect(daily.points[0]?.precipitationSum).toBeCloseTo(2.5, 5);
      expect(daily.points[0]?.weatherCode).toBe(1);
    });
  });

  it("reads polar-twilight symbols as the base symbol at night", async () => {
    const data = sampleResponse();
    data.properties.timeseries[0].data.next_1_hours = {
      summary: { symbol_code: "partlycloudy_polartwilight" },
      details: { precipitation_amount: 0, probability_of_precipitation: 0 },
    };
    mockFetch.mockResolvedValueOnce(mockOk(data));

    const { current } = await getProvider().getCurrentWeather(COORDS);
    expect(current.weatherCode).toBe(2);
    expect(current.isDay).toBe(false);
  });
});

/**
 * MET Norway's published symbol legend (Symbol ID, variant flag), from
 * https://github.com/metno/weathericons/blob/main/weather/legend.csv, including its
 * misspelt "lightssleet…" and "lightssnow…" IDs, which the API emits verbatim.
 */
const MET_LEGEND: ReadonlyArray<readonly [symbol: string, hasVariants: boolean, wmo: number]> = [
  ["clearsky", true, 0],
  ["fair", true, 1],
  ["partlycloudy", true, 2],
  ["cloudy", false, 3],
  ["lightrainshowers", true, 80],
  ["rainshowers", true, 81],
  ["heavyrainshowers", true, 82],
  ["lightrainshowersandthunder", true, 95],
  ["rainshowersandthunder", true, 95],
  ["heavyrainshowersandthunder", true, 97],
  ["lightsleetshowers", true, 83],
  ["sleetshowers", true, 84],
  ["heavysleetshowers", true, 84],
  ["lightssleetshowersandthunder", true, 95],
  ["sleetshowersandthunder", true, 95],
  ["heavysleetshowersandthunder", true, 97],
  ["lightsnowshowers", true, 85],
  ["snowshowers", true, 85],
  ["heavysnowshowers", true, 86],
  ["lightssnowshowersandthunder", true, 95],
  ["snowshowersandthunder", true, 95],
  ["heavysnowshowersandthunder", true, 97],
  ["lightrain", false, 61],
  ["rain", false, 63],
  ["heavyrain", false, 65],
  ["lightrainandthunder", false, 95],
  ["rainandthunder", false, 95],
  ["heavyrainandthunder", false, 97],
  ["lightsleet", false, 68],
  ["sleet", false, 69],
  ["heavysleet", false, 69],
  ["lightsleetandthunder", false, 95],
  ["sleetandthunder", false, 95],
  ["heavysleetandthunder", false, 97],
  ["lightsnow", false, 71],
  ["snow", false, 73],
  ["heavysnow", false, 75],
  ["lightsnowandthunder", false, 95],
  ["snowandthunder", false, 95],
  ["heavysnowandthunder", false, 97],
  ["fog", false, 45],
];

describe("MET Norway symbol legend", () => {
  it("covers all 41 published symbols", () => {
    expect(new Set(MET_LEGEND.map(([symbol]) => symbol)).size).toBe(41);
  });

  it.each(MET_LEGEND)("maps %s explicitly", (symbol, hasVariants, wmo) => {
    expect(Object.hasOwn(SYMBOL_TO_WMO, symbol)).toBe(true);
    expect(SYMBOL_TO_WMO[symbol]).toBe(wmo);
    expect(weatherCodeToDescription(wmo)).not.toBe("Unknown");

    const variants: Array<[string, boolean]> = hasVariants
      ? [
          [`${symbol}_day`, true],
          [`${symbol}_night`, false],
          [`${symbol}_polartwilight`, false],
        ]
      : [[symbol, true]];
    for (const [code, isDay] of variants) {
      expect(parseMetSymbol(code), code).toEqual({ wmo, isDay });
    }
  });

  it("leaves symbols outside the legend unmapped", () => {
    expect(parseMetSymbol("unlisted_night")).toEqual({ wmo: undefined, isDay: false });
  });
});
