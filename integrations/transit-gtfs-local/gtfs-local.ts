import type { BBox, Departure, TransitStop, TransportMode } from "@openmapx/core";

/**
 * Transit provider backed by locally-imported GTFS feeds in PostGIS.
 * Stops get prefixed IDs: "g-<slug>:<original_stop_id>".
 *
 * Dependencies are injected via setDeps() from the integration setup,
 * since the GTFS manager and queries live in apps/api.
 */

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

export interface GtfsDeps {
  manager: {
    initialized: boolean;
    getActiveFeedsForBbox(bbox: BBox): Array<{ slug: string; schemaName: string }>;
    getSchemaForStopId(stopId: string): string | null;
    getOriginalStopId(stopId: string): string | null;
    getSlugFromStopId(stopId: string): string | null;
    getFeeds(): Array<{ status: string; schemaName: string; slug: string }>;
  };
  queries: {
    routeTypeToMode(routeType: number): string;
    getStopsInBbox(schema: string, bbox: BBox, limit: number): Promise<GtfsStopRow[]>;
    getStopById(schema: string, stopId: string): Promise<GtfsStopRow | null>;
    searchStopsByName(schema: string, query: string, limit: number): Promise<GtfsStopRow[]>;
    getDepartures(schema: string, stopId: string, minutes: number): Promise<GtfsDepartureRow[]>;
    getArrivals(schema: string, stopId: string, minutes: number): Promise<GtfsDepartureRow[]>;
    getDeparturesByDate(schema: string, stopId: string, date: string): Promise<GtfsDepartureRow[]>;
    getChildStops(schema: string, stopId: string): Promise<GtfsStopRow[]>;
  };
}

let _deps: GtfsDeps | null = null;

export function setDeps(deps: GtfsDeps): void {
  _deps = deps;
}

function deps(): GtfsDeps {
  if (!_deps) throw new Error("GTFS deps not initialized. Call setDeps() first.");
  return _deps;
}

function toTransportMode(routeType: number): TransportMode {
  const mode = deps().queries.routeTypeToMode(routeType);
  const valid: TransportMode[] = [
    "bus",
    "rail",
    "subway",
    "tram",
    "ferry",
    "gondola",
    "funicular",
    "cable_car",
    "monorail",
  ];
  return valid.includes(mode as TransportMode) ? (mode as TransportMode) : "bus";
}

function rowToStop(row: GtfsStopRow, slug: string): TransitStop {
  return {
    id: `g-${slug}:${row.stop_id}`,
    name: row.stop_name ?? "Unknown",
    lat: row.stop_lat,
    lng: row.stop_lon,
    modes: row.route_types ? [...new Set(row.route_types.map(toTransportMode))] : ["bus"],
    platformCode: row.platform_code ?? undefined,
    parentStationId: row.parent_station ? `g-${slug}:${row.parent_station}` : undefined,
    provider: `gtfs-${slug}`,
  };
}

export async function getStops(bbox: BBox): Promise<TransitStop[]> {
  const { manager, queries } = deps();
  if (!manager.initialized) return [];

  const feeds = manager.getActiveFeedsForBbox(bbox);
  if (feeds.length === 0) return [];

  const tasks = feeds.map(async (feed) => {
    try {
      const rows = await queries.getStopsInBbox(feed.schemaName, bbox, 200);
      return rows.map((row) => rowToStop(row, feed.slug));
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  const stops: TransitStop[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") stops.push(...result.value);
  }
  return stops;
}

export async function getStopById(stopId: string): Promise<TransitStop | null> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return null;

  try {
    const row = await queries.getStopById(schema, originalId);
    if (!row) return null;
    return { ...rowToStop(row, slug), id: stopId };
  } catch {
    return null;
  }
}

export async function searchByName(query: string, limit = 20): Promise<TransitStop[]> {
  const { manager, queries } = deps();
  if (!manager.initialized) return [];

  const feeds = manager.getFeeds().filter((f) => f.status === "active");
  if (feeds.length === 0) return [];

  const tasks = feeds.map(async (feed) => {
    try {
      const rows = await queries.searchStopsByName(feed.schemaName, query, limit);
      return rows.map((row) => rowToStop(row, feed.slug));
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  const stops: TransitStop[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") stops.push(...result.value);
  }
  return stops;
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await queries.getDepartures(schema, originalId, minutes);
    return rows.map(
      (row): Departure => ({
        tripId: `g-${slug}:${row.trip_id}`,
        route: {
          id: `g-${slug}:${row.route_id}`,
          shortName: row.route_short_name ?? "",
          longName: row.route_long_name ?? "",
          mode: toTransportMode(row.route_type),
          color: row.route_color?.replace(/^#/, "") ?? undefined,
        },
        headsign: row.trip_headsign ?? "",
        scheduledAt: row.t_departure ?? "",
        canceled: false,
      }),
    );
  } catch {
    return [];
  }
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await queries.getArrivals(schema, originalId, minutes);
    return rows.map(
      (row): Departure => ({
        tripId: `g-${slug}:${row.trip_id}`,
        route: {
          id: `g-${slug}:${row.route_id}`,
          shortName: row.route_short_name ?? "",
          longName: row.route_long_name ?? "",
          mode: toTransportMode(row.route_type),
          color: row.route_color?.replace(/^#/, "") ?? undefined,
        },
        headsign: row.trip_headsign ?? "",
        scheduledAt: row.t_arrival ?? "",
        canceled: false,
      }),
    );
  } catch {
    return [];
  }
}

/** Return all scheduled departures for a specific date (YYYY-MM-DD). */
export async function getTimetable(stopId: string, date: string): Promise<Departure[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await queries.getDeparturesByDate(schema, originalId, date);
    return rows.map(
      (row): Departure => ({
        tripId: `g-${slug}:${row.trip_id}`,
        route: {
          id: `g-${slug}:${row.route_id}`,
          shortName: row.route_short_name ?? "",
          longName: row.route_long_name ?? "",
          mode: toTransportMode(row.route_type),
          color: row.route_color?.replace(/^#/, "") ?? undefined,
        },
        headsign: row.trip_headsign ?? "",
        scheduledAt: row.t_departure ?? "",
        canceled: false,
      }),
    );
  } catch {
    return [];
  }
}

export async function getPlatformStops(stopId: string): Promise<TransitStop[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await queries.getChildStops(schema, originalId);
    return rows.map((row) => rowToStop(row, slug));
  } catch {
    return [];
  }
}

/** Check if any local GTFS feeds cover the given bbox. */
export function hasCoverage(bbox: BBox): boolean {
  const { manager } = deps();
  if (!manager.initialized) return false;
  return manager.getActiveFeedsForBbox(bbox).length > 0;
}

/** Check if a stop ID belongs to a local GTFS feed. */
export function isGtfsLocalId(stopId: string): boolean {
  return stopId.startsWith("g-");
}
