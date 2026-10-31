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

const BASE_URL = "https://api.brightsky.dev";

type Intensity = "slight" | "moderate" | "heavy";

/**
 * WMO codes for the precipitation types in Bright Sky's `condition` and `icon`
 * vocabularies (https://api.brightsky.dev/openapi.json), graded by intensity.
 */
const PRECIPITATION_TO_WMO: Record<string, Record<Intensity, number>> = {
  rain: { slight: 61, moderate: 63, heavy: 65 },
  snow: { slight: 71, moderate: 73, heavy: 75 },
  sleet: { slight: 68, moderate: 69, heavy: 69 },
  hail: { slight: 89, moderate: 90, heavy: 90 },
};

const SKY_ICON_TO_WMO: Record<string, number> = {
  "clear-day": 0,
  "clear-night": 0,
  "partly-cloudy-day": 2,
  "partly-cloudy-night": 2,
  cloudy: 3,
};

/**
 * Grades a rate on the WMO rain-intensity bands (mm/h). An unknown amount gets
 * the slight code: it is the weakest claim the stated precipitation type allows.
 */
function intensity(rateMmPerHour: number | null): Intensity {
  if (rateMmPerHour == null || rateMmPerHour < 2.5) return "slight";
  return rateMmPerHour < 7.6 ? "moderate" : "heavy";
}

function cloudCoverToWmo(cloudCover: number | null): number {
  if (cloudCover != null) {
    if (cloudCover < 25) return 0;
    if (cloudCover < 75) return 2;
  }
  return 3;
}

interface BrightSkyConditions {
  condition?: string | null;
  icon: string | null;
  cloud_cover: number | null;
}

/**
 * Bright Sky's `icon` shows precipitation only above 0.5 mm and otherwise
 * prefers `wind` to the sky state, so the stated `condition` decides the
 * precipitation type and the measured cloud cover stands in for a `wind` icon.
 */
export function brightSkyWeatherCode(
  record: BrightSkyConditions,
  precipitationRateMmPerHour: number | null,
): number {
  const stated =
    record.condition && record.condition !== "dry" ? record.condition : (record.icon ?? "");
  if (stated === "fog") return 45;
  if (stated === "thunderstorm") return 95;
  const precipitation = PRECIPITATION_TO_WMO[stated];
  if (precipitation) return precipitation[intensity(precipitationRateMmPerHour)];
  return SKY_ICON_TO_WMO[stated] ?? cloudCoverToWmo(record.cloud_cover);
}

function iconIsDay(icon: string | null): boolean {
  if (!icon) return true;
  return !icon.includes("night");
}

interface BrightSkyCurrent {
  timestamp: string;
  cloud_cover: number | null;
  condition?: string | null;
  icon: string | null;
  precipitation_10: number | null;
  pressure_msl: number | null;
  relative_humidity: number | null;
  temperature: number | null;
  wind_direction_10: number | null;
  wind_gust_speed_10: number | null;
  wind_speed_10: number | null;
}

interface BrightSkyHourly {
  timestamp: string;
  cloud_cover: number | null;
  condition?: string | null;
  icon: string | null;
  precipitation: number | null;
  precipitation_probability: number | null;
  pressure_msl: number | null;
  relative_humidity: number | null;
  temperature: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
}

function fetchBrightSky<T>(url: string): Promise<T> {
  return fetchJsonWithTimeout<T>(url, { label: "Bright Sky" });
}

const brightSkyProvider: WeatherProvider = {
  id: "bright-sky",
  priority: 3,
  // Bright Sky documents that it changes DWD's data: `icon` and `condition`
  // are "calculated from different fields in the raw data as a best effort",
  // `/current_weather` compiles SYNOP observations, and gaps are filled from
  // fallback stations (https://brightsky.dev/docs/).
  changesSourceData: true,

  async getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse> {
    const lat = round4(coords[1]);
    const lon = round4(coords[0]);
    const data = await fetchBrightSky<{ weather: BrightSkyCurrent }>(
      `${BASE_URL}/current_weather?lat=${lat}&lon=${lon}`,
    );

    const w = data.weather;
    if (!w || w.temperature == null) throw new Error("No Bright Sky data (outside Germany?)");

    const isImperial = options?.units === "imperial";
    const temperature = w.temperature;
    // Bright Sky reports wind in km/h.
    const speed = (kmh: number | null) =>
      kmh == null ? undefined : isImperial ? kmh / 1.609 : kmh;

    return {
      location: coords,
      current: {
        temperature: isImperial ? (temperature * 9) / 5 + 32 : temperature,
        humidity: w.relative_humidity ?? undefined,
        pressure: w.pressure_msl ?? undefined,
        windSpeed: speed(w.wind_speed_10),
        windDirection: w.wind_direction_10 ?? undefined,
        windGusts: speed(w.wind_gust_speed_10),
        precipitation: w.precipitation_10 ?? undefined,
        cloudCover: w.cloud_cover ?? undefined,
        weatherCode: brightSkyWeatherCode(
          w,
          w.precipitation_10 == null ? null : w.precipitation_10 * 6,
        ),
        isDay: iconIsDay(w.icon),
        time: w.timestamp,
      },
      source: "bright-sky",
    };
  },

  async getHourlyForecast(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>> {
    const lat = round4(coords[1]);
    const lon = round4(coords[0]);
    const now = new Date();
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const data = await fetchBrightSky<{ weather: BrightSkyHourly[] }>(
      `${BASE_URL}/weather?lat=${lat}&lon=${lon}&date=${now.toISOString().slice(0, 10)}&last_date=${end.toISOString().slice(0, 10)}`,
    );

    if (!data.weather?.length) throw new Error("No forecast data from Bright Sky");

    const isImperial = options?.units === "imperial";

    const points = data.weather.slice(0, hours).map((h) => ({
      time: h.timestamp,
      temperature: isImperial ? ((h.temperature ?? 0) * 9) / 5 + 32 : (h.temperature ?? 0),
      weatherCode: brightSkyWeatherCode(h, h.precipitation),
      precipitationProbability: h.precipitation_probability ?? 0,
      precipitation: h.precipitation ?? 0,
      windSpeed: isImperial ? (h.wind_speed ?? 0) / 1.609 : (h.wind_speed ?? 0),
      windDirection: h.wind_direction ?? 0,
      cloudCover: h.cloud_cover ?? 0,
      pressure: h.pressure_msl ?? 0,
    }));
    return { source: "bright-sky", points };
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>> {
    const lat = round4(coords[1]);
    const lon = round4(coords[0]);
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const data = await fetchBrightSky<{ weather: BrightSkyHourly[] }>(
      `${BASE_URL}/weather?lat=${lat}&lon=${lon}&date=${now.toISOString().slice(0, 10)}&last_date=${end.toISOString().slice(0, 10)}`,
    );

    if (!data.weather?.length) throw new Error("No forecast data from Bright Sky");

    const isImperial = options?.units === "imperial";
    const convertTemp = (c: number) => (isImperial ? (c * 9) / 5 + 32 : c);

    const byDate = new Map<string, BrightSkyHourly[]>();
    for (const h of data.weather) {
      const date = h.timestamp.slice(0, 10);
      const arr = byDate.get(date);
      if (arr) arr.push(h);
      else byDate.set(date, [h]);
    }

    const results: DailyForecastPoint[] = [];
    for (const [date, entries] of byDate) {
      if (results.length >= days) break;

      let minTemp = Number.POSITIVE_INFINITY;
      let maxTemp = Number.NEGATIVE_INFINITY;
      let precipSum = 0;
      let maxWind = 0;

      for (const h of entries) {
        const temp = h.temperature ?? 0;
        if (temp < minTemp) minTemp = temp;
        if (temp > maxTemp) maxTemp = temp;
        precipSum += h.precipitation ?? 0;
        if ((h.wind_speed ?? 0) > maxWind) maxWind = h.wind_speed ?? 0;
      }

      const midday = entries.find((h) => h.timestamp.includes("T12:")) ?? entries[0];

      results.push({
        date,
        weatherCode: brightSkyWeatherCode(midday, midday.precipitation),
        temperatureMax: convertTemp(maxTemp),
        temperatureMin: convertTemp(minTemp),
        precipitationSum: precipSum,
        windSpeedMax: isImperial ? maxWind / 1.609 : maxWind,
      });
    }

    return { source: "bright-sky", points: results };
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(brightSkyProvider);
}
