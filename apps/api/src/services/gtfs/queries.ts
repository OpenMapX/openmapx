import type { BBox } from "@openmapx/core";
import { sql } from "./db";
import type { GtfsDepartureRow, GtfsStopRow } from "./types";

// Route Type → Mode Mapping

const ROUTE_TYPE_MODE: Record<number, string> = {
  0: "tram",
  1: "subway",
  2: "rail",
  3: "bus",
  4: "ferry",
  5: "cable_car",
  6: "gondola",
  7: "funicular",
  11: "bus", // trolleybus
  12: "monorail",
};

/** Map GTFS route_type (numeric, incl. extended) to TransportMode string. */
export function routeTypeToMode(routeType: number): string {
  if (ROUTE_TYPE_MODE[routeType]) return ROUTE_TYPE_MODE[routeType];
  // Google extended types: ranges
  if (routeType >= 100 && routeType < 200) return "rail";
  if (routeType >= 200 && routeType < 300) return "bus"; // coach
  if (routeType >= 400 && routeType < 500) return "subway"; // urban rail
  if (routeType >= 700 && routeType < 800) return "bus";
  if (routeType >= 900 && routeType < 1000) return "tram";
  if (routeType >= 1000 && routeType < 1100) return "ferry";
  if (routeType >= 1200 && routeType < 1300) return "ferry";
  if (routeType >= 1300 && routeType < 1400) return "gondola";
  if (routeType >= 1400 && routeType < 1500) return "funicular";
  return "bus";
}

// Stops

/**
 * Query stops within a bounding box from a specific GTFS schema.
 * Returns stops and stations (location_type 0 or 1).
 */
export async function getStopsInBbox(
  schema: string,
  bbox: BBox,
  limit = 200,
): Promise<GtfsStopRow[]> {
  const [west, south, east, north] = bbox;
  const rows = await sql.unsafe(
    `
    SELECT
      s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.platform_code,
      (
        SELECT ARRAY_AGG(DISTINCT r.route_type)
        FROM "${schema}".stop_times st2
        JOIN "${schema}".trips t2 ON t2.trip_id = st2.trip_id
        JOIN "${schema}".routes r ON r.route_id = t2.route_id
        WHERE st2.stop_id = s.stop_id
      ) as route_types
    FROM "${schema}".stops s
    WHERE s.stop_loc IS NOT NULL
      AND s.stop_loc::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND s.location_type IN (0, 1)
    ORDER BY s.stop_name
    LIMIT $5
    `,
    [west, south, east, north, limit],
  );
  return rows as unknown as GtfsStopRow[];
}

/**
 * Query a single stop by ID from a specific GTFS schema.
 */
export async function getStopById(schema: string, stopId: string): Promise<GtfsStopRow | null> {
  const rows = await sql.unsafe(
    `
    SELECT
      s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.platform_code,
      (
        SELECT ARRAY_AGG(DISTINCT r.route_type)
        FROM "${schema}".stop_times st2
        JOIN "${schema}".trips t2 ON t2.trip_id = st2.trip_id
        JOIN "${schema}".routes r ON r.route_id = t2.route_id
        WHERE st2.stop_id = s.stop_id
      ) as route_types
    FROM "${schema}".stops s
    WHERE s.stop_id = $1
    `,
    [stopId],
  );
  return rows.length > 0 ? (rows[0] as unknown as GtfsStopRow) : null;
}

/**
 * Search stops by name using case-insensitive substring match.
 * Returns stations and stops (location_type 0 or 1).
 */
export async function searchStopsByName(
  schema: string,
  query: string,
  limit = 20,
): Promise<GtfsStopRow[]> {
  const rows = await sql.unsafe(
    `
    SELECT
      s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.platform_code,
      (
        SELECT ARRAY_AGG(DISTINCT r.route_type)
        FROM "${schema}".stop_times st2
        JOIN "${schema}".trips t2 ON t2.trip_id = st2.trip_id
        JOIN "${schema}".routes r ON r.route_id = t2.route_id
        WHERE st2.stop_id = s.stop_id
      ) as route_types
    FROM "${schema}".stops s
    WHERE s.location_type IN (0, 1)
      AND s.stop_name ILIKE $1
    ORDER BY
      CASE WHEN s.location_type = 1 THEN 0 ELSE 1 END,
      s.stop_name
    LIMIT $2
    `,
    [`%${query}%`, limit],
  );
  return rows as unknown as GtfsStopRow[];
}

// Departures

/**
 * Query scheduled departures at a stop for the given time window.
 * Handles cross-midnight trips by checking yesterday's + today's service days.
 */
export async function getDepartures(
  schema: string,
  stopId: string,
  minutes: number,
): Promise<GtfsDepartureRow[]> {
  // Check if service_days view exists
  const viewCheck = await sql.unsafe(
    `
    SELECT EXISTS (
      SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = 'service_days'
    ) as exists
  `,
    [schema],
  );
  if (!viewCheck[0]?.exists) return [];

  const rows = await sql.unsafe(
    `
    SELECT
      st.trip_id,
      r.route_id,
      r.route_short_name,
      r.route_long_name,
      r.route_type,
      r.route_color,
      t.trip_headsign,
      (sd.date + st.departure_time) AS t_departure,
      st.stop_sequence
    FROM "${schema}".stop_times st
    JOIN "${schema}".trips t ON t.trip_id = st.trip_id
    JOIN "${schema}".routes r ON r.route_id = t.route_id
    JOIN "${schema}".service_days sd ON sd.service_id = t.service_id
    WHERE st.stop_id = $1
      AND sd.date >= CURRENT_DATE - 1
      AND sd.date <= CURRENT_DATE
      AND (sd.date + st.departure_time) >= NOW()
      AND (sd.date + st.departure_time) < NOW() + make_interval(mins => $2)
    ORDER BY t_departure
    LIMIT 50
    `,
    [stopId, minutes],
  );
  return rows as unknown as GtfsDepartureRow[];
}

/**
 * Query scheduled arrivals at a stop for the given time window.
 */
export async function getArrivals(
  schema: string,
  stopId: string,
  minutes: number,
): Promise<GtfsDepartureRow[]> {
  const viewCheck = await sql.unsafe(
    `
    SELECT EXISTS (
      SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = 'service_days'
    ) as exists
  `,
    [schema],
  );
  if (!viewCheck[0]?.exists) return [];

  const rows = await sql.unsafe(
    `
    SELECT
      st.trip_id,
      r.route_id,
      r.route_short_name,
      r.route_long_name,
      r.route_type,
      r.route_color,
      t.trip_headsign,
      (sd.date + st.arrival_time) AS t_arrival,
      st.stop_sequence
    FROM "${schema}".stop_times st
    JOIN "${schema}".trips t ON t.trip_id = st.trip_id
    JOIN "${schema}".routes r ON r.route_id = t.route_id
    JOIN "${schema}".service_days sd ON sd.service_id = t.service_id
    WHERE st.stop_id = $1
      AND sd.date >= CURRENT_DATE - 1
      AND sd.date <= CURRENT_DATE
      AND (sd.date + st.arrival_time) >= NOW()
      AND (sd.date + st.arrival_time) < NOW() + make_interval(mins => $2)
    ORDER BY t_arrival
    LIMIT 50
    `,
    [stopId, minutes],
  );
  return rows as unknown as GtfsDepartureRow[];
}

/**
 * Query child stops (platforms) of a parent station.
 */
export async function getChildStops(schema: string, parentStopId: string): Promise<GtfsStopRow[]> {
  const rows = await sql.unsafe(
    `
    SELECT
      s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.platform_code,
      NULL::integer[] as route_types
    FROM "${schema}".stops s
    WHERE s.parent_station = $1
    ORDER BY s.platform_code NULLS LAST, s.stop_name
    `,
    [parentStopId],
  );
  return rows as unknown as GtfsStopRow[];
}

/**
 * Query all departures for a specific date (full-day timetable).
 * Unlike getDepartures(), this is not time-window constrained.
 */
export async function getDeparturesByDate(
  schema: string,
  stopId: string,
  date: string,
): Promise<GtfsDepartureRow[]> {
  const viewCheck = await sql.unsafe(
    `
    SELECT EXISTS (
      SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = 'service_days'
    ) as exists
    `,
    [schema],
  );
  if (!viewCheck[0]?.exists) return [];

  const rows = await sql.unsafe(
    `
    SELECT
      st.trip_id,
      r.route_id,
      r.route_short_name,
      r.route_long_name,
      r.route_type,
      r.route_color,
      t.trip_headsign,
      (sd.date + st.departure_time) AS t_departure,
      st.stop_sequence
    FROM "${schema}".stop_times st
    JOIN "${schema}".trips t ON t.trip_id = st.trip_id
    JOIN "${schema}".routes r ON r.route_id = t.route_id
    JOIN "${schema}".service_days sd ON sd.service_id = t.service_id
    WHERE st.stop_id = $1
      AND sd.date = $2::date
    ORDER BY t_departure
    LIMIT 300
    `,
    [stopId, date],
  );
  return rows as unknown as GtfsDepartureRow[];
}

// Schema Discovery

/** List all GTFS schemas that exist in the database. */
export async function listGtfsSchemas(): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'gtfs_%'
    ORDER BY schema_name
  `);
  return rows.map((r) => r.schema_name as string);
}

/** Get row counts for a GTFS schema. */
export async function getSchemaStats(
  schema: string,
): Promise<{ stops: number; routes: number; trips: number }> {
  const [stops, routes, trips] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*) as c FROM "${schema}".stops WHERE location_type IN (0, 1)`),
    sql.unsafe(`SELECT COUNT(*) as c FROM "${schema}".routes`),
    sql.unsafe(`SELECT COUNT(*) as c FROM "${schema}".trips`),
  ]);
  return {
    stops: Number(stops[0].c),
    routes: Number(routes[0].c),
    trips: Number(trips[0].c),
  };
}
