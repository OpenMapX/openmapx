import type { BBox, Departure, TransitStop, TransportMode } from "@openmapx/core";
import { gtfsManager } from "../../gtfs/index";
import * as gtfsQueries from "../../gtfs/queries";
import type { GtfsStopRow } from "../../gtfs/types";

/**
 * Transit provider backed by locally-imported GTFS feeds in PostGIS.
 * Stops get prefixed IDs: "g-<slug>:<original_stop_id>".
 */

function toTransportMode(routeType: number): TransportMode {
  const mode = gtfsQueries.routeTypeToMode(routeType);
  // Ensure the string is a valid TransportMode
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
  if (!gtfsManager.initialized) return [];

  const feeds = gtfsManager.getActiveFeedsForBbox(bbox);
  if (feeds.length === 0) return [];

  const tasks = feeds.map(async (feed) => {
    try {
      const rows = await gtfsQueries.getStopsInBbox(feed.schemaName, bbox, 200);
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
  const schema = gtfsManager.getSchemaForStopId(stopId);
  const originalId = gtfsManager.getOriginalStopId(stopId);
  const slug = gtfsManager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return null;

  try {
    const row = await gtfsQueries.getStopById(schema, originalId);
    if (!row) return null;
    return { ...rowToStop(row, slug), id: stopId };
  } catch {
    return null;
  }
}

export async function searchByName(query: string, limit = 20): Promise<TransitStop[]> {
  if (!gtfsManager.initialized) return [];

  const feeds = gtfsManager.getFeeds().filter((f) => f.status === "active");
  if (feeds.length === 0) return [];

  const tasks = feeds.map(async (feed) => {
    try {
      const rows = await gtfsQueries.searchStopsByName(feed.schemaName, query, limit);
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
  const schema = gtfsManager.getSchemaForStopId(stopId);
  const originalId = gtfsManager.getOriginalStopId(stopId);
  const slug = gtfsManager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await gtfsQueries.getDepartures(schema, originalId, minutes);
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
  const schema = gtfsManager.getSchemaForStopId(stopId);
  const originalId = gtfsManager.getOriginalStopId(stopId);
  const slug = gtfsManager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await gtfsQueries.getArrivals(schema, originalId, minutes);
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
  const schema = gtfsManager.getSchemaForStopId(stopId);
  const originalId = gtfsManager.getOriginalStopId(stopId);
  const slug = gtfsManager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await gtfsQueries.getDeparturesByDate(schema, originalId, date);
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
  const schema = gtfsManager.getSchemaForStopId(stopId);
  const originalId = gtfsManager.getOriginalStopId(stopId);
  const slug = gtfsManager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await gtfsQueries.getChildStops(schema, originalId);
    return rows.map((row) => rowToStop(row, slug));
  } catch {
    return [];
  }
}

/** Check if any local GTFS feeds cover the given bbox. */
export function hasCoverage(bbox: BBox): boolean {
  if (!gtfsManager.initialized) return false;
  return gtfsManager.getActiveFeedsForBbox(bbox).length > 0;
}

/** Check if a stop ID belongs to a local GTFS feed. */
export function isGtfsLocalId(stopId: string): boolean {
  return stopId.startsWith("g-");
}
