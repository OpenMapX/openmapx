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

export type {
  MetObservation as MetReadings,
  TideEvent,
  WaterLevelObservation as WaterLevelReading,
} from "@openmapx/integration-framework";
