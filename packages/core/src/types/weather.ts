import type { ContributingRecord } from "@openmapx/mobility-core/contributors";
import type { LngLat } from "./geometry";

export interface WeatherOptions {
  lang?: string;
  units?: "metric" | "imperial";
}

/** Readings a provider does not report are absent, never zero-filled. */
export interface CurrentWeather {
  temperature: number;
  /** Apparent temperature, only from providers that compute one. */
  feelsLike?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  precipitation?: number;
  cloudCover?: number;
  weatherCode: number;
  isDay: boolean;
  time: string;
}

export interface HourlyForecastPoint extends ContributingRecord {
  time: string;
  temperature: number;
  weatherCode: number;
  precipitationProbability: number;
  precipitation: number;
  windSpeed: number;
  windDirection: number;
  cloudCover: number;
  pressure: number;
}

export interface DailyForecastPoint extends ContributingRecord {
  date: string;
  weatherCode: number;
  temperatureMax: number;
  temperatureMin: number;
  precipitationSum: number;
  windSpeedMax: number;
  sunrise?: string;
  sunset?: string;
}

/** A selected forecast acquisition; point receipts survive filtering and serialization. */
export interface WeatherForecastResponse<T extends ContributingRecord> extends ContributingRecord {
  points: T[];
  /** Exact serving source, or null when no provider returned a forecast. */
  source: string | null;
}

export interface WeatherResponse extends ContributingRecord {
  location: LngLat;
  current: CurrentWeather;
  hourly?: HourlyForecastPoint[];
  daily?: DailyForecastPoint[];
  source: string;
}

export interface RadarFrame {
  time: number;
  path: string;
}

export interface RadarMeta {
  host: string;
  past: RadarFrame[];
  nowcast: RadarFrame[];
}

export type WeatherSubLayer =
  | "radar"
  | "temperature"
  | "clouds"
  | "wind"
  | "pressure"
  | "precipitation";

export type TemperatureUnit = "celsius" | "fahrenheit";
export type WindSpeedUnit = "kmh" | "mph" | "ms" | "knots";
