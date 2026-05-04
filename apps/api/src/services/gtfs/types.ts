import type { BBox } from "@openmapx/core";

export interface CatalogFeed {
  id: string;
  name: string;
  source: "transitous" | "mobilitydb" | "manual" | "opentransportdata-swiss";
  countryCode: string;
  url: string;
  license?: string;
  bbox?: BBox;
}

export type FeedStatus = "pending" | "downloading" | "importing" | "active" | "failed" | "stale";

export interface ImportedFeed {
  slug: string;
  name: string;
  url: string;
  /**
   * Optional upstream HTTP URL the feed was originally fetched from when
   * `url` is now a `local:<filename>` pseudo-URL pointing at a MOTIS-fetched
   * archive. Lets the UI render "imported from local zip · originally
   * https://www.vbb.de/…" and unblocks future "refresh from upstream" actions.
   * `null` for direct-URL imports where `url` already is the origin.
   */
  originUrl: string | null;
  source: string;
  countryCode: string;
  schemaName: string;
  status: FeedStatus;
  bbox: BBox | null;
  feedHash: string | null;
  importedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  stopCount: number | null;
  routeCount: number | null;
  tripCount: number | null;
  /**
   * Last calendar date the feed schedules service for. Computed from
   * `MAX(calendar.end_date)` plus added `calendar_dates` exceptions during
   * import; null when the feed lacks any calendar data. ISO `YYYY-MM-DD`.
   * Surfaced in the admin UI to flag stale feeds — once this passes "today"
   * the feed is no longer routable for that day.
   */
  serviceEndDate: string | null;
  /**
   * Live import-stage label streamed from the importer (e.g. `"importing
   * stop_times"`, `"swapping schema"`). Set while `status` is `downloading`
   * or `importing`, cleared back to null on success/failure. Transient,
   * not persisted in `gtfs_feeds` — the admin UI polls it.
   */
  currentStage: string | null;
}

/** Row from a GTFS stops query */
export interface GtfsStopRow {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type: number;
  parent_station: string | null;
  platform_code: string | null;
  original_stop_id?: string | null;
  route_types: number[] | null;
}

/** Row from a GTFS departure or arrival query */
export interface GtfsDepartureRow {
  trip_id: string;
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string | null;
  trip_headsign: string | null;
  /** Scheduled departure time (ISO string) — present on departure rows */
  t_departure?: string;
  /** Scheduled arrival time (ISO string) — present on arrival rows */
  t_arrival?: string;
  stop_sequence: number;
}

export interface GtfsRepresentativeTripRow {
  trip_id: string;
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string | null;
  route_text_color: string | null;
  trip_headsign: string | null;
  shape_id: string | null;
  agency_name: string | null;
}

export interface GtfsTripStopRow {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  parent_station: string | null;
  platform_code: string | null;
  original_stop_id: string | null;
  stop_sequence: number;
}

export interface GtfsShapePointRow {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
}
