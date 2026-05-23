import type { BBox } from "@openmapx/core";
import type {
  Departure,
  GeoJSONLineString,
  TransitRoute,
  TransitStop,
  TransportMode,
  VehicleJourney,
  VehicleJourneyStop,
} from "@openmapx/mobility-core/transit";

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

/** Row from a GTFS trip-stops query (sequence + scheduled times). */
export interface GtfsTripStopRow {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  parent_station: string | null;
  platform_code: string | null;
  original_stop_id: string | null;
  stop_sequence: number;
  /** Scheduled arrival as ISO string, anchored to CURRENT_DATE (see queries.ts). */
  t_arrival: string | null;
  /** Scheduled departure as ISO string, anchored to CURRENT_DATE (see queries.ts). */
  t_departure: string | null;
}

/** Row from a GTFS routes query (joined with agency for operator name). */
export interface GtfsRouteRow {
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
  route_color: string | null;
  route_text_color: string | null;
  agency_name: string | null;
}

/** Row from a GTFS shapes query. */
export interface GtfsShapePointRow {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
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
    /**
     * Returns the full ImportedFeed shape. The extra optional fields
     * (`name`, `url`, `license`, `licenseUrl`) feed the per-feed
     * attribution surface in `getFeedAttribution()`; the manager
     * persists them from the catalog row at import time.
     */
    getFeeds(): Array<{
      status: string;
      schemaName: string;
      slug: string;
      name?: string;
      url?: string;
      license?: string | null;
      licenseUrl?: string | null;
    }>;
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
    getTripStops(schema: string, tripId: string): Promise<GtfsTripStopRow[]>;
    getRouteById(schema: string, routeId: string): Promise<GtfsRouteRow | null>;
    getRoutesForStop(schema: string, stopId: string): Promise<GtfsRouteRow[]>;
    getRouteStops(schema: string, routeId: string, hintStopId?: string): Promise<GtfsTripStopRow[]>;
    getTripShapeId(schema: string, tripId: string): Promise<string | null>;
    getTripStopSequenceRange(
      schema: string,
      tripId: string,
      fromStopId: string,
      toStopId: string,
    ): Promise<{ from: number; to: number } | null>;
    getShapePoints(schema: string, shapeId: string): Promise<GtfsShapePointRow[]>;
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

/**
 * Fetch the ordered stop list for a single trip. Used by the trip-detail
 * panel via the orchestrator's `getVehicleJourney`.
 *
 * The `tripId` arrives prefixed with `g-<slug>:` from the merged-departure
 * dedup; we strip the prefix to get the raw GTFS `trip_id` before querying
 * the feed's schema. Returns null when the prefix doesn't resolve to an
 * active feed or the trip has no stop_times rows.
 */
export async function getVehicleJourney(tripId: string): Promise<VehicleJourney | null> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(tripId);
  const originalTripId = manager.getOriginalStopId(tripId);
  const slug = manager.getSlugFromStopId(tripId);
  if (!schema || !originalTripId || !slug) return null;

  try {
    const rows = await queries.getTripStops(schema, originalTripId);
    if (rows.length === 0) return null;
    const stops: VehicleJourneyStop[] = rows.map((row) => ({
      stopId: `g-${slug}:${row.stop_id}`,
      name: row.stop_name ?? "",
      lat: row.stop_lat,
      lng: row.stop_lon,
      platform: row.platform_code ?? undefined,
      scheduledArrival: row.t_arrival ?? undefined,
      scheduledDeparture: row.t_departure ?? undefined,
    }));
    return {
      id: tripId,
      name: originalTripId,
      provider: `gtfs-${slug}`,
      stops,
    };
  } catch {
    return null;
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

function rowToRoute(row: GtfsRouteRow, slug: string): TransitRoute {
  return {
    id: `g-${slug}:${row.route_id}`,
    shortName: row.route_short_name ?? "",
    longName: row.route_long_name ?? "",
    mode: toTransportMode(row.route_type),
    color: row.route_color?.replace(/^#/, "") ?? undefined,
    textColor: row.route_text_color?.replace(/^#/, "") ?? undefined,
    operatorName: row.agency_name ?? "",
  };
}

/** Single route by id. Returns null when the prefix doesn't resolve to an active feed. */
export async function getRoute(routeId: string): Promise<TransitRoute | null> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(routeId);
  const originalRouteId = manager.getOriginalStopId(routeId);
  const slug = manager.getSlugFromStopId(routeId);
  if (!schema || !originalRouteId || !slug) return null;

  try {
    const row = await queries.getRouteById(schema, originalRouteId);
    if (!row) return null;
    return rowToRoute(row, slug);
  } catch {
    return null;
  }
}

/** Routes that serve a given stop. */
export async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(stopId);
  const originalId = manager.getOriginalStopId(stopId);
  const slug = manager.getSlugFromStopId(stopId);
  if (!schema || !originalId || !slug) return [];

  try {
    const rows = await queries.getRoutesForStop(schema, originalId);
    return rows.map((row) => rowToRoute(row, slug));
  } catch {
    return [];
  }
}

/**
 * Stops served by a route. `hintStopId` (if supplied and on the same feed)
 * biases the picked representative trip toward the direction the user
 * clicked from.
 */
export async function getRouteStops(routeId: string, hintStopId?: string): Promise<TransitStop[]> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(routeId);
  const originalRouteId = manager.getOriginalStopId(routeId);
  const slug = manager.getSlugFromStopId(routeId);
  if (!schema || !originalRouteId || !slug) return [];

  // Hint must come from the same feed; cross-feed hints are silently ignored.
  let originalHint: string | undefined;
  if (hintStopId) {
    const hintSlug = manager.getSlugFromStopId(hintStopId);
    if (hintSlug === slug) {
      originalHint = manager.getOriginalStopId(hintStopId) ?? undefined;
    }
  }

  try {
    const rows = await queries.getRouteStops(schema, originalRouteId, originalHint);
    return rows.map((row) => ({
      id: `g-${slug}:${row.stop_id}`,
      name: row.stop_name ?? "Unknown",
      lat: row.stop_lat,
      lng: row.stop_lon,
      modes: [],
      platformCode: row.platform_code ?? undefined,
      parentStationId: row.parent_station ? `g-${slug}:${row.parent_station}` : undefined,
      provider: `gtfs-${slug}`,
    }));
  } catch {
    return [];
  }
}

/**
 * Trip shape as a GeoJSON LineString. When `fromStopId`/`toStopId` are
 * supplied, the shape is trimmed to the matching stop_sequence range so the
 * directions panel can render only the relevant leg.
 *
 * Trimming uses stop locations (not shape_dist_traveled, which most feeds
 * omit): we pick the shape points whose nearest-stop window falls within
 * [fromSeq, toSeq] using a simple bracket search.
 */
export async function getLegGeometry(
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  const { manager, queries } = deps();
  const schema = manager.getSchemaForStopId(tripId);
  const originalTripId = manager.getOriginalStopId(tripId);
  const slug = manager.getSlugFromStopId(tripId);
  if (!schema || !originalTripId || !slug) return null;

  try {
    const shapeId = await queries.getTripShapeId(schema, originalTripId);
    if (!shapeId) return null;
    const points = await queries.getShapePoints(schema, shapeId);
    if (points.length === 0) return null;

    // No trim requested → full shape.
    if (!fromStopId || !toStopId) {
      return {
        type: "LineString",
        coordinates: points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
      };
    }

    // Resolve the original stop ids on the same feed; otherwise fall through
    // to full shape rather than returning a misleading empty leg.
    const fromSlug = manager.getSlugFromStopId(fromStopId);
    const toSlug = manager.getSlugFromStopId(toStopId);
    const fromOriginal = manager.getOriginalStopId(fromStopId);
    const toOriginal = manager.getOriginalStopId(toStopId);
    if (fromSlug !== slug || toSlug !== slug || !fromOriginal || !toOriginal) {
      return {
        type: "LineString",
        coordinates: points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
      };
    }

    const range = await queries.getTripStopSequenceRange(
      schema,
      originalTripId,
      fromOriginal,
      toOriginal,
    );
    if (!range) {
      return {
        type: "LineString",
        coordinates: points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
      };
    }

    // Without shape_dist_traveled we approximate: split shape proportionally
    // by stop_sequence position within the trip's full stop list. Looking up
    // the trip's total stop count keeps the math simple — bracket the shape
    // by [from/total, to/total] of its length.
    const tripStops = await queries.getTripStops(schema, originalTripId);
    if (tripStops.length === 0) {
      return {
        type: "LineString",
        coordinates: points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
      };
    }
    const minSeq = Math.min(...tripStops.map((s) => s.stop_sequence));
    const maxSeq = Math.max(...tripStops.map((s) => s.stop_sequence));
    const span = Math.max(maxSeq - minSeq, 1);
    const startFrac = (range.from - minSeq) / span;
    const endFrac = (range.to - minSeq) / span;
    const startIdx = Math.max(0, Math.floor(startFrac * (points.length - 1)));
    const endIdx = Math.min(points.length - 1, Math.ceil(endFrac * (points.length - 1)));
    const slice = points.slice(startIdx, endIdx + 1);
    if (slice.length < 2) {
      return {
        type: "LineString",
        coordinates: points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
      };
    }
    return {
      type: "LineString",
      coordinates: slice.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
    };
  } catch {
    return null;
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

/**
 * Per-feed attribution map. Keys match `TransitStop.provider`
 * (`gtfs-<slug>`) so envelope `attributions` carry the imported feed's
 * `name` + `license` directly instead of falling back to a synthesized
 * "GTFS (<slug>)" label.
 *
 * Only active feeds are surfaced — inactive/failed feeds shouldn't
 * advertise license claims they aren't actually serving data under.
 */
export function getFeedAttributions(): Record<
  string,
  { label: string; url: string; license?: string; licenseUrl?: string }
> {
  const { manager } = deps();
  if (!manager.initialized) return {};
  const feeds = manager.getFeeds().filter((f) => f.status === "active");
  const map: Record<string, { label: string; url: string; license?: string; licenseUrl?: string }> =
    {};
  for (const feed of feeds) {
    map[`gtfs-${feed.slug}`] = {
      label: feed.name ?? feed.slug,
      url: feed.url ?? "",
      license: feed.license ?? undefined,
      licenseUrl: feed.licenseUrl ?? undefined,
    };
  }
  return map;
}
