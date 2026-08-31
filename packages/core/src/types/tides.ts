export interface TideEvent {
  /** Station-local wall time or ISO-8601 with an explicit UTC offset. */
  time: string;
  type: "H" | "L";
  valueFt: number;
}

export interface TideCurvePoint {
  time: string;
  valueFt: number;
}

export interface WaterLevelObservation {
  time: string;
  valueFt: number;
  /** Provider quality flag, including NOAA preliminary and verified samples. */
  quality?: "p" | "v" | string;
}

export interface MetObservation {
  /** Temperatures are Fahrenheit, wind is knots/degrees, and pressure is millibars. */
  airTempF?: number;
  waterTempF?: number;
  windKnots?: number;
  windDirDeg?: number;
  windGustKnots?: number;
  pressureMb?: number;
  humidityPct?: number;
  time?: string;
}

export interface TideResponseStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  timezoneCorrHours?: number;
}

export interface TidesPayload {
  station: TideResponseStation;
  events: TideEvent[];
  curve: TideCurvePoint[];
  datum: "MLLW";
  units: "english";
  timeZone: "lst_ldt";
  currentLevel?: WaterLevelObservation;
  met?: MetObservation;
}

export interface TideProvider {
  integrationId: string;
  sourceId: string;
}

export interface TidesResponse extends TidesPayload {
  provider: TideProvider;
}
