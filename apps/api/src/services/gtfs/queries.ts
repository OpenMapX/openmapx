import { type BBox, isValidFeedSlug } from "@openmapx/core";
import { mapGtfsRouteTypeToMode } from "@openmapx/mobility-formats";
import { sql } from "./db";
import type {
  GtfsDepartureRow,
  GtfsRepresentativeTripRow,
  GtfsRouteRow,
  GtfsShapePointRow,
  GtfsStopRow,
  GtfsTripStopRow,
} from "./types";

/** Map GTFS route_type (numeric, incl. extended) to TransportMode string. */
export function routeTypeToMode(routeType: number): string {
  return mapGtfsRouteTypeToMode(routeType);
}

/**
 * Defense-in-depth guard for the `${schema}` interpolations below. Every
 * persisted schema name is `gtfs_<slug>` where `<slug>` is feed-slug-shaped;
 * route-level validation already enforces that. This guard prevents future
 * callers from passing arbitrary identifiers — a single misuse would otherwise
 * become a SQL-identifier injection.
 */
function assertValidGtfsSchema(schema: string): void {
  if (!schema.startsWith("gtfs_")) {
    throw new Error(`Invalid GTFS schema name "${schema}" — must begin with "gtfs_"`);
  }
  if (!isValidFeedSlug(schema.slice("gtfs_".length))) {
    throw new Error(`Invalid GTFS schema name "${schema}"`);
  }
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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
  assertValidGtfsSchema(schema);
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

const schemaStopOriginalIdSupport = new Map<string, boolean>();

/** Invalidate per-schema metadata caches. Call before/after a schema is dropped or re-imported. */
export function invalidateSchemaCaches(schema: string): void {
  schemaStopOriginalIdSupport.delete(schema);
}

async function hasOriginalStopIdColumn(schema: string): Promise<boolean> {
  assertValidGtfsSchema(schema);
  const cached = schemaStopOriginalIdSupport.get(schema);
  if (cached !== undefined) return cached;

  const rows = await sql.unsafe(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'stops'
        AND column_name = 'original_stop_id'
    ) AS exists
    `,
    [schema],
  );
  const exists = rows[0]?.exists === true;
  schemaStopOriginalIdSupport.set(schema, exists);
  return exists;
}

export async function findRepresentativeTrip(
  schema: string,
  options: {
    routeShortName: string;
    headsign?: string;
    operatorName?: string;
    stopRefs?: string[];
    stopNames?: string[];
  },
): Promise<GtfsRepresentativeTripRow | null> {
  assertValidGtfsSchema(schema);
  const stopRefTerms = [
    ...new Set((options.stopRefs ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  const stopNameTerms = [
    ...new Set(
      (options.stopNames ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const hasOriginalStopId = await hasOriginalStopIdColumn(schema);
  const originalStopIdExpr = hasOriginalStopId ? "COALESCE(s.original_stop_id, '')" : "''";

  const rows = await sql.unsafe(
    `
    WITH candidate_trips AS (
      SELECT
        t.trip_id,
        r.route_id,
        r.route_short_name,
        r.route_long_name,
        r.route_type,
        r.route_color,
        r.route_text_color,
        t.trip_headsign,
        t.shape_id,
        a.agency_name,
        COUNT(*) FILTER (
          WHERE cardinality($4::text[]) > 0
            AND (
              s.stop_id = ANY($4::text[])
              OR ${originalStopIdExpr} = ANY($4::text[])
            )
        ) AS stop_ref_matches,
        COUNT(*) FILTER (
          WHERE cardinality($5::text[]) > 0
            AND lower(s.stop_name) = ANY($5::text[])
        ) AS stop_name_matches,
        CASE
          WHEN $2::text IS NULL THEN 0
          WHEN COALESCE(t.trip_headsign, '') ILIKE $2::text THEN 2
          WHEN COALESCE(r.route_long_name, '') ILIKE $2::text THEN 1
          ELSE 0
        END AS headsign_score,
        CASE
          WHEN $3::text IS NULL THEN 0
          WHEN COALESCE(a.agency_name, '') ILIKE $3::text THEN 2
          ELSE 0
        END AS operator_score,
        COUNT(*) AS stop_count,
        (
          SELECT MIN(ABS(sd.date - CURRENT_DATE))
          FROM "${schema}".service_days sd
          WHERE sd.service_id = t.service_id
        ) AS day_distance
      FROM "${schema}".trips t
      JOIN "${schema}".routes r ON r.route_id = t.route_id
      LEFT JOIN "${schema}".agency a ON a.agency_id = r.agency_id
      JOIN "${schema}".stop_times st ON st.trip_id = t.trip_id
      JOIN "${schema}".stops s ON s.stop_id = st.stop_id
      WHERE r.route_short_name = $1
      GROUP BY
        t.trip_id,
        r.route_id,
        r.route_short_name,
        r.route_long_name,
        r.route_type,
        r.route_color,
        r.route_text_color,
        t.trip_headsign,
        t.shape_id,
        a.agency_name
    )
    SELECT
      trip_id,
      route_id,
      route_short_name,
      route_long_name,
      route_type,
      route_color,
      route_text_color,
      trip_headsign,
      shape_id,
      agency_name
    FROM candidate_trips
    ORDER BY
      stop_ref_matches DESC,
      stop_name_matches DESC,
      headsign_score DESC,
      operator_score DESC,
      day_distance ASC NULLS LAST,
      stop_count DESC,
      trip_id ASC
    LIMIT 1
    `,
    [
      options.routeShortName,
      options.headsign ? `%${options.headsign}%` : null,
      options.operatorName ? `%${options.operatorName}%` : null,
      stopRefTerms,
      stopNameTerms,
    ],
  );
  return rows.length > 0 ? (rows[0] as unknown as GtfsRepresentativeTripRow) : null;
}

export async function getTripStops(schema: string, tripId: string): Promise<GtfsTripStopRow[]> {
  assertValidGtfsSchema(schema);
  const hasOriginalStopId = await hasOriginalStopIdColumn(schema);
  const originalStopIdExpr = hasOriginalStopId ? "s.original_stop_id" : "NULL::text";
  // GTFS `trip_id` is not date-stamped (the same id can run on many service
  // days), so we anchor the schedule to CURRENT_DATE for display purposes.
  // The trip-detail UI cares about the wall-clock time of day, not the
  // calendar date — and GTFS times can exceed 24h (e.g. 25:30:00 for an
  // overnight leg), so adding to a date keeps the resulting timestamp
  // well-formed for formatTime.
  const rows = await sql.unsafe(
    `
    SELECT
      s.stop_id,
      s.stop_name,
      s.stop_lat,
      s.stop_lon,
      s.parent_station,
      s.platform_code,
      ${originalStopIdExpr} AS original_stop_id,
      st.stop_sequence,
      (CURRENT_DATE + st.arrival_time) AS t_arrival,
      (CURRENT_DATE + st.departure_time) AS t_departure
    FROM "${schema}".stop_times st
    JOIN "${schema}".stops s ON s.stop_id = st.stop_id
    WHERE st.trip_id = $1
    ORDER BY st.stop_sequence
    `,
    [tripId],
  );
  return rows as unknown as GtfsTripStopRow[];
}

export async function getShapePoints(
  schema: string,
  shapeId: string,
): Promise<GtfsShapePointRow[]> {
  assertValidGtfsSchema(schema);
  const rows = await sql.unsafe(
    `
    SELECT
      shape_pt_lat,
      shape_pt_lon,
      shape_pt_sequence
    FROM "${schema}".shapes
    WHERE shape_id = $1
    ORDER BY shape_pt_sequence
    `,
    [shapeId],
  );
  return rows as unknown as GtfsShapePointRow[];
}

/**
 * Single route by id, joined with the agency for operator name.
 */
export async function getRouteById(schema: string, routeId: string): Promise<GtfsRouteRow | null> {
  assertValidGtfsSchema(schema);
  const rows = await sql.unsafe(
    `
    SELECT
      r.route_id,
      r.route_short_name,
      r.route_long_name,
      r.route_type,
      r.route_color,
      r.route_text_color,
      a.agency_name
    FROM "${schema}".routes r
    LEFT JOIN "${schema}".agency a ON a.agency_id = r.agency_id
    WHERE r.route_id = $1
    LIMIT 1
    `,
    [routeId],
  );
  return rows.length > 0 ? (rows[0] as unknown as GtfsRouteRow) : null;
}

/**
 * Distinct routes whose trips visit a given stop. Joins stop_times → trips →
 * routes and dedupes on route_id.
 */
export async function getRoutesForStop(schema: string, stopId: string): Promise<GtfsRouteRow[]> {
  assertValidGtfsSchema(schema);
  const rows = await sql.unsafe(
    `
    SELECT DISTINCT ON (r.route_id)
      r.route_id,
      r.route_short_name,
      r.route_long_name,
      r.route_type,
      r.route_color,
      r.route_text_color,
      a.agency_name
    FROM "${schema}".stop_times st
    JOIN "${schema}".trips t ON t.trip_id = st.trip_id
    JOIN "${schema}".routes r ON r.route_id = t.route_id
    LEFT JOIN "${schema}".agency a ON a.agency_id = r.agency_id
    WHERE st.stop_id = $1
    ORDER BY r.route_id
    `,
    [stopId],
  );
  return rows as unknown as GtfsRouteRow[];
}

/**
 * Stops served by a route. Picks one representative trip — preferring a trip
 * that visits `hintStopId` so the returned stop sequence reflects the
 * direction of travel the user clicked from. Falls back to the trip with the
 * most stops on this route when no hint is supplied or none matches.
 */
export async function getRouteStops(
  schema: string,
  routeId: string,
  hintStopId?: string,
): Promise<GtfsTripStopRow[]> {
  assertValidGtfsSchema(schema);
  const hasOriginalStopId = await hasOriginalStopIdColumn(schema);
  const originalStopIdExpr = hasOriginalStopId ? "s.original_stop_id" : "NULL::text";
  // Two-step: pick the representative trip, then return its stops. Done as a
  // single CTE so the schema interpolation only happens once.
  const rows = await sql.unsafe(
    `
    WITH chosen_trip AS (
      SELECT t.trip_id, COUNT(st2.stop_id) AS stop_count,
        BOOL_OR(st2.stop_id = $2) AS has_hint
      FROM "${schema}".trips t
      JOIN "${schema}".stop_times st2 ON st2.trip_id = t.trip_id
      WHERE t.route_id = $1
      GROUP BY t.trip_id
      ORDER BY has_hint DESC, stop_count DESC
      LIMIT 1
    )
    SELECT
      s.stop_id,
      s.stop_name,
      s.stop_lat,
      s.stop_lon,
      s.parent_station,
      s.platform_code,
      ${originalStopIdExpr} AS original_stop_id,
      st.stop_sequence,
      (CURRENT_DATE + st.arrival_time) AS t_arrival,
      (CURRENT_DATE + st.departure_time) AS t_departure
    FROM "${schema}".stop_times st
    JOIN "${schema}".stops s ON s.stop_id = st.stop_id
    JOIN chosen_trip ct ON ct.trip_id = st.trip_id
    ORDER BY st.stop_sequence
    `,
    [routeId, hintStopId ?? ""],
  );
  return rows as unknown as GtfsTripStopRow[];
}

/**
 * Resolve a trip's `shape_id` from the trips table. Returns null when the
 * trip has no shape (some feeds omit shapes.txt entirely).
 */
export async function getTripShapeId(schema: string, tripId: string): Promise<string | null> {
  assertValidGtfsSchema(schema);
  const rows = await sql.unsafe(
    `
    SELECT shape_id
    FROM "${schema}".trips
    WHERE trip_id = $1
    LIMIT 1
    `,
    [tripId],
  );
  if (rows.length === 0) return null;
  const shapeId = (rows[0] as unknown as { shape_id: string | null }).shape_id;
  return shapeId ?? null;
}

/**
 * Map a stop_id pair to its inclusive `stop_sequence` range on a trip. Used to
 * trim a shape to a leg of the trip — only meaningful when both stops are on
 * the trip's stop_times. Returns null when either stop isn't found.
 */
export async function getTripStopSequenceRange(
  schema: string,
  tripId: string,
  fromStopId: string,
  toStopId: string,
): Promise<{ from: number; to: number } | null> {
  assertValidGtfsSchema(schema);
  const rows = await sql.unsafe(
    `
    SELECT stop_id, stop_sequence
    FROM "${schema}".stop_times
    WHERE trip_id = $1 AND stop_id IN ($2, $3)
    `,
    [tripId, fromStopId, toStopId],
  );
  let from: number | null = null;
  let to: number | null = null;
  for (const r of rows as unknown as Array<{ stop_id: string; stop_sequence: number }>) {
    if (r.stop_id === fromStopId) from = r.stop_sequence;
    if (r.stop_id === toStopId) to = r.stop_sequence;
  }
  if (from === null || to === null) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}
