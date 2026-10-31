import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { fetchJsonWithTimeout, round4 } from "@openmapx/integration-weather/lib";
import type { WeatherProvider } from "@openmapx/integration-weather/types";

const BASE_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

/**
 * Every symbol in MET Norway's legend
 * (https://github.com/metno/weathericons/blob/main/weather/legend.csv), keyed
 * without its `_day`/`_night`/`_polartwilight` variant suffix. Normal-strength
 * snow showers and thunder take the lighter WMO code because WMO's next step
 * up is described as heavy. The legend's misspelt "lightssleet…" and
 * "lightssnow…" IDs are what the API emits; the corrected spellings are kept
 * in case MET fixes them.
 */
export const SYMBOL_TO_WMO: Readonly<Record<string, number>> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightsleet: 68,
  sleet: 69,
  heavysleet: 69,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightrainshowers: 80,
  rainshowers: 81,
  heavyrainshowers: 82,
  lightsleetshowers: 83,
  sleetshowers: 84,
  heavysleetshowers: 84,
  lightsnowshowers: 85,
  snowshowers: 85,
  heavysnowshowers: 86,
  lightrainandthunder: 95,
  rainandthunder: 95,
  heavyrainandthunder: 97,
  lightsleetandthunder: 95,
  sleetandthunder: 95,
  heavysleetandthunder: 97,
  lightsnowandthunder: 95,
  snowandthunder: 95,
  heavysnowandthunder: 97,
  lightrainshowersandthunder: 95,
  rainshowersandthunder: 95,
  heavyrainshowersandthunder: 97,
  lightssleetshowersandthunder: 95,
  lightsleetshowersandthunder: 95,
  sleetshowersandthunder: 95,
  heavysleetshowersandthunder: 97,
  lightssnowshowersandthunder: 95,
  lightsnowshowersandthunder: 95,
  snowshowersandthunder: 95,
  heavysnowshowersandthunder: 97,
};

interface MetInstantDetails {
  air_temperature: number;
  air_pressure_at_sea_level: number;
  cloud_area_fraction: number;
  relative_humidity: number;
  wind_from_direction: number;
  wind_speed: number;
  wind_speed_of_gust?: number;
}

interface MetPeriodDetails {
  precipitation_amount: number;
  precipitation_amount_max?: number;
  precipitation_amount_min?: number;
  probability_of_precipitation?: number;
  air_temperature_max?: number;
  air_temperature_min?: number;
}

interface MetTimeseriesEntry {
  time: string;
  data: {
    instant: { details: MetInstantDetails };
    next_1_hours?: { summary: { symbol_code: string }; details: MetPeriodDetails };
    next_6_hours?: { summary: { symbol_code: string }; details: MetPeriodDetails };
  };
}

interface MetResponse {
  properties: {
    meta: { updated_at: string };
    timeseries: MetTimeseriesEntry[];
  };
}

const VARIANT_SUFFIX = /_(day|night|polartwilight)$/;

/** Polar twilight means the sun is below the horizon, so it reads as night. */
export function parseMetSymbol(symbolCode: string): { wmo: number | undefined; isDay: boolean } {
  const variant = VARIANT_SUFFIX.exec(symbolCode);
  const base = variant ? symbolCode.slice(0, variant.index) : symbolCode;
  return {
    wmo: Object.hasOwn(SYMBOL_TO_WMO, base) ? SYMBOL_TO_WMO[base] : undefined,
    isDay: !variant || variant[1] === "day",
  };
}

function cloudCoverToWmo(cloudCover: number): number {
  if (cloudCover < 25) return 0;
  if (cloudCover < 75) return 2;
  return 3;
}

/**
 * An entry's symbol for its own next period. Without a known symbol, the
 * forecast cloud cover is classified rather than guessing a condition.
 */
function entryConditions(entry: MetTimeseriesEntry): { wmo: number; isDay: boolean } {
  const symbol =
    entry.data.next_1_hours?.summary.symbol_code ?? entry.data.next_6_hours?.summary.symbol_code;
  const parsed = symbol ? parseMetSymbol(symbol) : { wmo: undefined, isDay: true };
  return {
    wmo: parsed.wmo ?? cloudCoverToWmo(entry.data.instant.details.cloud_area_fraction),
    isDay: parsed.isDay,
  };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The precipitation each entry contributes to a sum without double counting.
 * Hourly steps also carry overlapping `next_6_hours` totals, so an entry counts
 * its `next_1_hours` amount, or its `next_6_hours` amount only when it has no
 * hourly period (the later 6-hourly steps); a period starting inside one
 * already counted is skipped.
 */
function countedPrecipitation(timeseries: MetTimeseriesEntry[]): Map<MetTimeseriesEntry, number> {
  const counted = new Map<MetTimeseriesEntry, number>();
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const entry of timeseries) {
    const start = Date.parse(entry.time);
    if (start < coveredUntil) continue;
    if (entry.data.next_1_hours) {
      counted.set(entry, entry.data.next_1_hours.details.precipitation_amount);
      coveredUntil = start + HOUR_MS;
    } else if (entry.data.next_6_hours) {
      counted.set(entry, entry.data.next_6_hours.details.precipitation_amount);
      coveredUntil = start + 6 * HOUR_MS;
    }
  }
  return counted;
}

function fetchCompact(coords: LngLat): Promise<MetResponse> {
  const url = `${BASE_URL}?lat=${round4(coords[1])}&lon=${round4(coords[0])}`;
  return fetchJsonWithTimeout<MetResponse>(url, { label: "MET Norway" });
}

const metNorwayProvider: WeatherProvider = {
  id: "met-norway",
  priority: 8,

  async getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse> {
    const data = await fetchCompact(coords);
    const entry = data.properties.timeseries[0];
    if (!entry) throw new Error("No timeseries data from MET Norway");

    const d = entry.data.instant.details;
    const { wmo, isDay } = entryConditions(entry);

    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6; // m/s → mph or km/h

    return {
      location: coords,
      current: {
        temperature: isImperial ? (d.air_temperature * 9) / 5 + 32 : d.air_temperature,
        humidity: d.relative_humidity,
        pressure: d.air_pressure_at_sea_level,
        windSpeed: d.wind_speed * windMultiplier,
        windDirection: d.wind_from_direction,
        windGusts: d.wind_speed_of_gust != null ? d.wind_speed_of_gust * windMultiplier : undefined,
        // A next_6_hours total is not a current amount.
        precipitation: entry.data.next_1_hours?.details.precipitation_amount,
        cloudCover: d.cloud_area_fraction,
        weatherCode: wmo,
        isDay,
        time: entry.time,
      },
      source: "met-norway",
    };
  },

  async getHourlyForecast(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>> {
    const data = await fetchCompact(coords);
    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6;
    const results: HourlyForecastPoint[] = [];

    for (const entry of data.properties.timeseries) {
      if (!entry.data.next_1_hours) continue;
      if (results.length >= hours) break;

      const d = entry.data.instant.details;
      const { wmo } = entryConditions(entry);

      results.push({
        time: entry.time,
        temperature: isImperial ? (d.air_temperature * 9) / 5 + 32 : d.air_temperature,
        weatherCode: wmo,
        precipitationProbability: entry.data.next_1_hours.details.probability_of_precipitation ?? 0,
        precipitation: entry.data.next_1_hours.details.precipitation_amount,
        windSpeed: d.wind_speed * windMultiplier,
        windDirection: d.wind_from_direction,
        cloudCover: d.cloud_area_fraction,
        pressure: d.air_pressure_at_sea_level,
      });
    }

    return { source: "met-norway", points: results };
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>> {
    const data = await fetchCompact(coords);
    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6;

    const counted = countedPrecipitation(data.properties.timeseries);
    const byDate = new Map<string, MetTimeseriesEntry[]>();
    for (const entry of data.properties.timeseries) {
      const date = entry.time.slice(0, 10);
      const arr = byDate.get(date);
      if (arr) arr.push(entry);
      else byDate.set(date, [entry]);
    }

    const results: DailyForecastPoint[] = [];
    for (const [date, entries] of byDate) {
      if (results.length >= days) break;

      let minTemp = Number.POSITIVE_INFINITY;
      let maxTemp = Number.NEGATIVE_INFINITY;
      let precipSum = 0;
      let maxWind = 0;

      for (const entry of entries) {
        precipSum += counted.get(entry) ?? 0;
        const temp = entry.data.instant.details.air_temperature;
        if (temp < minTemp) minTemp = temp;
        if (temp > maxTemp) maxTemp = temp;
        if (entry.data.instant.details.wind_speed > maxWind) {
          maxWind = entry.data.instant.details.wind_speed;
        }
        if (entry.data.next_6_hours?.details) {
          const d6 = entry.data.next_6_hours.details;
          if (d6.air_temperature_min != null && d6.air_temperature_min < minTemp)
            minTemp = d6.air_temperature_min;
          if (d6.air_temperature_max != null && d6.air_temperature_max > maxTemp)
            maxTemp = d6.air_temperature_max;
        }
      }

      const middayEntry = entries.find((e) => e.time.includes("T12:")) ?? entries[0];
      const { wmo } = entryConditions(middayEntry);

      const convertTemp = (c: number) => (isImperial ? (c * 9) / 5 + 32 : c);

      results.push({
        date,
        weatherCode: wmo,
        temperatureMax: convertTemp(maxTemp),
        temperatureMin: convertTemp(minTemp),
        precipitationSum: precipSum,
        windSpeedMax: maxWind * windMultiplier,
      });
    }

    return { source: "met-norway", points: results };
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(metNorwayProvider);
}
