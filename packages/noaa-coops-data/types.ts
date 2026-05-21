/** What the station publishes, derived from the MDAPI `type=` filter we asked for. */
export type NoaaStationType =
  | "tide-predictions"
  | "water-level"
  | "currents"
  | "currents-predictions";

/**
 * Minimal NOAA CO-OPS station representation cached in Redis. The MDAPI
 * response carries many more fields (sensors, datums, harmonics, …) but
 * those are looked up on demand per-station, not cached in the catalog.
 */
export interface NoaaStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Two-letter US state/territory code from NOAA (e.g. "CA", "MA", "HI"). */
  state?: string;
  /**
   * Hours offset from UTC for the station's local standard time (LST), e.g.
   * -5 for an Atlantic station. NOAA returns this as `timezonecorr`.
   */
  timezoneCorrHours?: number;
  /** Catalog this station belongs to. A single station can appear in several. */
  types: NoaaStationType[];
  /** Whether the station has tide-prediction harmonics — drives the "Tides" widget. */
  tidal?: boolean;
}

/** A single high or low tide event for a station. */
export interface TideEvent {
  /** Local time of the event, `YYYY-MM-DD HH:mm` in the station's `lst_ldt` time zone. */
  time: string;
  /** "H" for high, "L" for low. */
  type: "H" | "L";
  /** Water level above the datum, in feet (NOAA's default for `units=english`). */
  valueFt: number;
}

/** Latest 6-min observed water-level sample. */
export interface WaterLevelReading {
  /** Local time `YYYY-MM-DD HH:mm` in the station's `lst_ldt` time zone. */
  time: string;
  valueFt: number;
  /** NOAA quality flag — "p" preliminary, "v" verified. Surface "p" to the user. */
  quality?: "p" | "v" | string;
}

/** Latest met readings — only populated for stations that publish them. */
export interface MetReadings {
  /** Air temperature in °F. */
  airTempF?: number;
  /** Water temperature in °F. */
  waterTempF?: number;
  /** Wind speed in knots. */
  windKnots?: number;
  /** Wind direction in degrees (0–360). */
  windDirDeg?: number;
  /** Wind gust in knots. */
  windGustKnots?: number;
  /** Barometric pressure in millibars. */
  pressureMb?: number;
  /** Relative humidity (%). */
  humidityPct?: number;
  /** Time of latest sample (string from NOAA, station-local lst_ldt). */
  time?: string;
}
