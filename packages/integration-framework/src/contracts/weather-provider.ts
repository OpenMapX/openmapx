import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";

export type {
  CurrentWeather,
  DailyForecastPoint,
  HourlyForecastPoint,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";

export interface WeatherProvider {
  readonly id: string;
  readonly priority: number;

  getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse>;

  getHourlyForecast?(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<HourlyForecastPoint[]>;

  getDailyForecast?(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]>;
}
