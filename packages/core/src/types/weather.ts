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
