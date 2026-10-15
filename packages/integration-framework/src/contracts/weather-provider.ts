import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";

export type {
  CurrentWeather,
  DailyForecastPoint,
  HourlyForecastPoint,
  WeatherForecastResponse,
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
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>>;

  getDailyForecast?(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>>;
}
