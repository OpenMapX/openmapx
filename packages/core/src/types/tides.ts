import type { ContributingRecord, FieldContributors } from "@openmapx/mobility-core/contributors";
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

/**
 * Vertical reference the network measures heights from. Values are re-encoded
 * to feet but keep this reference.
 *
 * - `MLLW`: mean lower low water, the tidal datum NOAA CO-OPS requests use.
 * - `chart_datum`: the national hydrographic chart datum (CHS in Canada,
 *   Kartverket's sjøkartnull in Norway).
 * - `gauge_zero`: the gauge's own zero point, for example a WSV
 *   Pegelnullpunkt; not a tidal datum.
 * - `sensor_reference`: the instrument's unreferenced level, as relayed raw by
 *   the IOC monitoring facility; only differences between readings are meaningful.
 */
export type TideDatum = "MLLW" | "chart_datum" | "gauge_zero" | "sensor_reference";

/**
 * Form of every timestamp in the payload.
 *
 * - `lst_ldt`: station-local standard/daylight wall time without an offset
 *   (NOAA CO-OPS `time_zone=lst_ldt`).
 * - `iso_offset`: ISO-8601 carrying its own UTC offset or `Z`.
 */
export type TideTimeZone = "lst_ldt" | "iso_offset";

/**
 * Where the `events` and `curve` heights come from.
 *
 * - `prediction`: the network's harmonic tide predictions, which model the
 *   astronomical tide only and leave out wind set-up and storm surge.
 * - `observation`: measured water levels, which include wind and surge; any
 *   high and low events are derived from the measurements.
 *
 * `currentLevel` is always a measurement.
 */
export type TideHeightSource = "prediction" | "observation";

export interface TidesPayload extends ContributingRecord {
  /** Captured ownership for independently acquired station, predictions and observations. */
  fieldContributors?: FieldContributors;
  station: TideResponseStation;
  events: TideEvent[];
  curve: TideCurvePoint[];
  datum: TideDatum;
  units: "english";
  timeZone: TideTimeZone;
  heightSource: TideHeightSource;
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
