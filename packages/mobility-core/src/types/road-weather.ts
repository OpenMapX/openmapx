import type { Attribution } from "./attribution.js";

/** The OpenConditions `surface_state` vocabulary: what lies on the road. */
export type RoadSurfaceState =
  | "dry"
  | "damp"
  | "wet"
  | "frost"
  | "ice"
  | "black_ice"
  | "snow"
  | "packed_snow"
  | "slush"
  | "standing_water"
  | "flooded"
  | "chemically_wet"
  | "unknown";

/** The OpenConditions `precipitation_type` vocabulary. */
export type PrecipitationType =
  | "none"
  | "rain"
  | "snow"
  | "sleet"
  | "hail"
  | "drizzle"
  | "freezing_rain";

/** One measured value and when it was measured, as an ISO 8601 timestamp. */
export interface RoadWeatherValue<T> {
  value: T;
  observedAt?: string;
}

/** What a station measures in the air above the road. */
export interface RoadWeatherAir {
  temperatureC?: RoadWeatherValue<number>;
  dewPointC?: RoadWeatherValue<number>;
  /** Relative humidity, in percent. */
  humidityPct?: RoadWeatherValue<number>;
  visibilityM?: RoadWeatherValue<number>;
  /** The mean wind speed of the last ten minutes. */
  windSpeedMs?: RoadWeatherValue<number>;
  /** The strongest gust of the last ten minutes. */
  windGustMs?: RoadWeatherValue<number>;
  /** Where the wind blows from, in degrees clockwise from north. */
  windDirectionDeg?: RoadWeatherValue<number>;
  precipitation?: RoadWeatherValue<PrecipitationType>;
  precipitationMmH?: RoadWeatherValue<number>;
}

/**
 * What one surface sensor of a station measures. A station may carry
 * several, usually one per lane or wheel track, numbered from 1.
 */
export interface RoadSurfaceSensor {
  index: number;
  state?: RoadWeatherValue<RoadSurfaceState>;
  temperatureC?: RoadWeatherValue<number>;
  subsurfaceTemperatureC?: RoadWeatherValue<number>;
  freezingPointC?: RoadWeatherValue<number>;
  /** The friction coefficient, 0 to 1. */
  friction?: RoadWeatherValue<number>;
  waterFilmMm?: RoadWeatherValue<number>;
  snowDepthMm?: RoadWeatherValue<number>;
  iceThicknessMm?: RoadWeatherValue<number>;
  /** The salt on the surface, in kg/m³. */
  saltKgM3?: RoadWeatherValue<number>;
}

/** A road weather station beside a road and what it measures now. */
export interface RoadWeatherStation {
  id: string;
  name: string;
  country?: string;
  coordinates: [number, number];
  /** The road the station stands by, as its number or name. */
  road?: string;
  /** The municipality the station stands in. */
  municipality?: string;
  /** A station `temporarily_closed` collects nothing for now (out of service or offline). */
  status: "operational" | "temporarily_closed";
  /**
   * A fault its operator suspects or has confirmed in the station's
   * equipment, since when: its values may be wrong.
   */
  fault?: { level: "suspected" | "confirmed"; since?: string };
  air: RoadWeatherAir;
  /** The station's surface sensors, by index. */
  surface: RoadSurfaceSensor[];
  /** When the newest of its values was measured, as an ISO 8601 timestamp. */
  updatedAt?: string;
  /** True when its values are older than they stay current, or it has none. */
  stale: boolean;
  sources: string[];
  attributions: Attribution[];
}
