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

const BASE_URL = "https://api.brightsky.dev";

const ICON_TO_WMO: Record<string, number> = {
  "clear-day": 0,
  "clear-night": 0,
  "partly-cloudy-day": 2,
  "partly-cloudy-night": 2,
  cloudy: 3,
  fog: 45,
  wind: 3,
  rain: 63,
  sleet: 67,
  snow: 73,
  hail: 96,
  thunderstorm: 95,
};

function iconToWmo(icon: string | null, cloudCover: number | null): number {
  if (icon && icon in ICON_TO_WMO) return ICON_TO_WMO[icon];
  if (cloudCover != null) {
    if (cloudCover < 25) return 0;
    if (cloudCover < 75) return 2;
  }
  return 3;
}

function iconIsDay(icon: string | null): boolean {
  if (!icon) return true;
  return !icon.includes("night");
}

interface BrightSkyCurrent {
  timestamp: string;
  cloud_cover: number | null;
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

  async getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse> {
    const lat = round4(coords[1]);
    const lon = round4(coords[0]);
    const data = await fetchBrightSky<{ weather: BrightSkyCurrent }>(
      `${BASE_URL}/current_weather?lat=${lat}&lon=${lon}`,
    );

    const w = data.weather;
    if (!w || w.temperature == null) throw new Error("No Bright Sky data (outside Germany?)");

    const isImperial = options?.units === "imperial";
    // Bright Sky returns wind in km/h already
    const windSpeed = w.wind_speed_10 ?? 0;
    const windGusts = w.wind_gust_speed_10 ?? undefined;

    return {
      location: coords,
      current: {
        temperature: isImperial ? ((w.temperature ?? 0) * 9) / 5 + 32 : (w.temperature ?? 0),
        feelsLike: isImperial ? ((w.temperature ?? 0) * 9) / 5 + 32 : (w.temperature ?? 0),
        humidity: w.relative_humidity ?? 0,
        pressure: w.pressure_msl ?? 0,
        windSpeed: isImperial ? windSpeed / 1.609 : windSpeed,
        windDirection: w.wind_direction_10 ?? 0,
        windGusts: windGusts != null ? (isImperial ? windGusts / 1.609 : windGusts) : undefined,
        precipitation: w.precipitation_10 ?? 0,
        cloudCover: w.cloud_cover ?? 0,
        weatherCode: iconToWmo(w.icon, w.cloud_cover),
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
  ): Promise<HourlyForecastPoint[]> {
    const lat = round4(coords[1]);
    const lon = round4(coords[0]);
    const now = new Date();
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const data = await fetchBrightSky<{ weather: BrightSkyHourly[] }>(
      `${BASE_URL}/weather?lat=${lat}&lon=${lon}&date=${now.toISOString().slice(0, 10)}&last_date=${end.toISOString().slice(0, 10)}`,
    );

    if (!data.weather?.length) throw new Error("No forecast data from Bright Sky");

    const isImperial = options?.units === "imperial";

    return data.weather.slice(0, hours).map((h) => ({
      time: h.timestamp,
      temperature: isImperial ? ((h.temperature ?? 0) * 9) / 5 + 32 : (h.temperature ?? 0),
      weatherCode: iconToWmo(h.icon, h.cloud_cover),
      precipitationProbability: h.precipitation_probability ?? 0,
      precipitation: h.precipitation ?? 0,
      windSpeed: isImperial ? (h.wind_speed ?? 0) / 1.609 : (h.wind_speed ?? 0),
      windDirection: h.wind_direction ?? 0,
      cloudCover: h.cloud_cover ?? 0,
      pressure: h.pressure_msl ?? 0,
    }));
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]> {
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
        weatherCode: iconToWmo(midday.icon, midday.cloud_cover),
        temperatureMax: convertTemp(maxTemp),
        temperatureMin: convertTemp(minTemp),
        precipitationSum: precipSum,
        windSpeedMax: isImperial ? maxWind / 1.609 : maxWind,
      });
    }

    return results;
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(brightSkyProvider);
}
