import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { fetchJsonWithTimeout, round4 } from "@openmapx/integration-weather/lib";
import type { WeatherProvider } from "@openmapx/integration-weather/types";

const BASE_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

const SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  lightrainshowers: 61,
  rain: 63,
  rainshowers: 63,
  heavyrain: 65,
  heavyrainshowers: 65,
  lightsleet: 66,
  sleet: 67,
  heavysleet: 67,
  lightsnow: 71,
  lightsnowshowers: 71,
  snow: 73,
  snowshowers: 73,
  heavysnow: 75,
  heavysnowshowers: 75,
  lightrainandthunder: 95,
  rainandthunder: 95,
  heavyrainandthunder: 96,
  sleetandthunder: 96,
  snowandthunder: 96,
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

function parseSymbol(symbolCode: string): { wmo: number; isDay: boolean } {
  let base = symbolCode;
  let isDay = true;
  if (base.endsWith("_day")) {
    base = base.replace(/_day$/, "");
  } else if (base.endsWith("_night")) {
    base = base.replace(/_night$/, "");
    isDay = false;
  }
  return { wmo: SYMBOL_TO_WMO[base] ?? 3, isDay };
}

function getBestSymbol(entry: MetTimeseriesEntry): string {
  return (
    entry.data.next_1_hours?.summary.symbol_code ??
    entry.data.next_6_hours?.summary.symbol_code ??
    "cloudy"
  );
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
    const symbol = getBestSymbol(entry);
    const { wmo, isDay } = parseSymbol(symbol);
    const precip =
      entry.data.next_1_hours?.details.precipitation_amount ??
      entry.data.next_6_hours?.details.precipitation_amount ??
      0;

    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6; // m/s → mph or km/h

    return {
      location: coords,
      current: {
        temperature: isImperial ? (d.air_temperature * 9) / 5 + 32 : d.air_temperature,
        feelsLike: isImperial ? (d.air_temperature * 9) / 5 + 32 : d.air_temperature,
        humidity: d.relative_humidity,
        pressure: d.air_pressure_at_sea_level,
        windSpeed: d.wind_speed * windMultiplier,
        windDirection: d.wind_from_direction,
        windGusts: d.wind_speed_of_gust != null ? d.wind_speed_of_gust * windMultiplier : undefined,
        precipitation: precip,
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
  ): Promise<HourlyForecastPoint[]> {
    const data = await fetchCompact(coords);
    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6;
    const results: HourlyForecastPoint[] = [];

    for (const entry of data.properties.timeseries) {
      if (!entry.data.next_1_hours) continue;
      if (results.length >= hours) break;

      const d = entry.data.instant.details;
      const { wmo } = parseSymbol(entry.data.next_1_hours.summary.symbol_code);

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

    return results;
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]> {
    const data = await fetchCompact(coords);
    const isImperial = options?.units === "imperial";
    const windMultiplier = isImperial ? 2.237 : 3.6;

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
        const temp = entry.data.instant.details.air_temperature;
        if (temp < minTemp) minTemp = temp;
        if (temp > maxTemp) maxTemp = temp;
        if (entry.data.instant.details.wind_speed > maxWind) {
          maxWind = entry.data.instant.details.wind_speed;
        }
        if (entry.data.next_1_hours) {
          precipSum += entry.data.next_1_hours.details.precipitation_amount;
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
      const { wmo } = parseSymbol(getBestSymbol(middayEntry));

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

    return results;
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("weather", metNorwayProvider);
}
