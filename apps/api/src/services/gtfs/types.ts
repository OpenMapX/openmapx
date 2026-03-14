import type { BBox } from "../transit/types";

export interface CatalogFeed {
  id: string;
  name: string;
  source: "transitous" | "mobilitydb" | "manual";
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
