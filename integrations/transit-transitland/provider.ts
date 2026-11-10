import { type BBox, fetchJson } from "@openmapx/core";
import { parseProviderPayload, parseProviderRecords } from "@openmapx/integration-framework";
import type {
  Departure,
  TransitRoute,
  TransitStop,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import { GTFS_ROUTE_TYPE_MODE, mapGtfsRouteTypeToMode } from "@openmapx/mobility-formats";
import { z } from "zod";

const BASE_URL = "https://transit.land/api/v2/rest";

// Populated by setup(ctx) from the resolved integration config cascade.
let transitlandApiKey: string | null = null;
export function setTransitlandApiKey(value: string | undefined): void {
  transitlandApiKey = value && value.length > 0 ? value : null;
}

function apiKey(): string | null {
  return transitlandApiKey;
}

/**
 * Fetch a Transitland resource. Failures throw without the keyed request URL;
 * the cause keeps the HTTP status for provider health.
 */
async function tlFetch(
  path: string,
  params: Record<string, string>,
  what: string,
): Promise<unknown> {
  const key = apiKey();
  if (!key) return null;
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apikey", key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  try {
    return await fetchJson<unknown>(url.toString(), {
      errorMessage: ({ status }) => `TransitLand ${path} → HTTP ${status}`,
    });
  } catch (error) {
    throw new Error(`Transitland ${what} unavailable`, { cause: error });
  }
}

const optionalText = z.string().nullish();
const hexColor = optionalText.transform((value) => (value ? value.replace(/^#/, "") : undefined));
const coordinate = z.number().finite();

const stopSchema = z.object({
  onestop_id: z.string().min(1),
  stop_name: optionalText,
  geometry: z.object({
    coordinates: z
      .tuple([coordinate.min(-180).max(180), coordinate.min(-90).max(90)])
      .rest(z.unknown()),
  }),
  platform_code: optionalText,
  parent: z.object({ onestop_id: optionalText }).nullish(),
  route_stops: z
    .array(z.object({ route: z.object({ route_type: z.number().int().nullish() }).nullish() }))
    .nullish(),
});
type TransitlandStop = z.infer<typeof stopSchema>;
const stopsEnvelope = z.object({ stops: z.array(z.unknown()) });

const routeSchema = z.object({
  onestop_id: z.string().min(1),
  route_type: z.number().int(),
  route_short_name: optionalText,
  route_long_name: optionalText,
  route_color: hexColor,
  route_text_color: hexColor,
  agency: z.object({ agency_name: optionalText }).nullish(),
  geometry: z.unknown().optional(),
});
type TransitlandRoute = z.infer<typeof routeSchema>;
const routesEnvelope = z.object({ routes: z.array(z.unknown()) });

/** A departure's scheduled and realtime instants live in its `departure` event. */
const departureSchema = z.object({
  departure: z.object({
    scheduled_utc: z.iso.datetime({ offset: true }),
    estimated_utc: z.iso.datetime({ offset: true }).nullish(),
  }),
  schedule_relationship: optionalText,
  stop_headsign: optionalText,
  trip: z.object({
    trip_id: z.string(),
    trip_headsign: optionalText,
    schedule_relationship: optionalText,
    route: z.object({
      onestop_id: optionalText,
      route_type: z.number().int().nullish(),
      route_short_name: optionalText,
      route_long_name: optionalText,
      route_color: hexColor,
    }),
  }),
});
type TransitlandDeparture = z.infer<typeof departureSchema>;
const departuresEnvelope = z.object({
  stops: z.array(
    z.object({
      platform_code: optionalText,
      departures: z.array(z.unknown()),
    }),
  ),
});

function mapModes(routeTypes: number[]): TransportMode[] {
  if (!routeTypes.length) return ["bus"];
  return routeTypes.map((t) => mapGtfsRouteTypeToMode(t));
}

function normalizeStop(s: TransitlandStop): TransitStop {
  const [lng, lat] = s.geometry.coordinates;
  const routeTypes = (s.route_stops ?? []).flatMap((rs) =>
    typeof rs.route?.route_type === "number" ? [rs.route.route_type] : [],
  );
  return {
    id: `tl:${s.onestop_id}`,
    name: s.stop_name ?? "Unknown",
    lat,
    lng,
    modes: mapModes(routeTypes),
    platformCode: s.platform_code ?? undefined,
    parentStationId: s.parent?.onestop_id ? `tl:${s.parent.onestop_id}` : undefined,
    provider: "transitland",
  };
}

function normalizeRoute(r: TransitlandRoute): TransitRoute {
  return {
    id: `tl:${r.onestop_id}`,
    shortName: r.route_short_name ?? r.route_long_name ?? "",
    longName: r.route_long_name ?? r.route_short_name ?? "",
    mode: mapGtfsRouteTypeToMode(r.route_type),
    color: r.route_color,
    textColor: r.route_text_color,
    operatorName: r.agency?.agency_name ?? "",
    geometry: (r.geometry ?? undefined) as TransitRoute["geometry"],
  };
}

const CANCELED = new Set(["CANCELED", "DELETED", "SKIPPED"]);

function normalizeDeparture(d: TransitlandDeparture, platform: string | undefined): Departure {
  const route = d.trip.route;
  const scheduledAt = new Date(d.departure.scheduled_utc).toISOString();
  const expectedAt = d.departure.estimated_utc
    ? new Date(d.departure.estimated_utc).toISOString()
    : undefined;
  const delaySeconds = expectedAt
    ? Math.round((Date.parse(expectedAt) - Date.parse(scheduledAt)) / 1000)
    : undefined;
  return {
    tripId: d.trip.trip_id,
    route: {
      id: route.onestop_id ? `tl:${route.onestop_id}` : "",
      shortName: route.route_short_name ?? "",
      longName: route.route_long_name ?? "",
      mode: mapGtfsRouteTypeToMode(route.route_type ?? 3),
      color: route.route_color,
    },
    headsign: d.trip.trip_headsign ?? d.stop_headsign ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds: delaySeconds ? delaySeconds : undefined,
    platform,
    canceled:
      CANCELED.has(d.schedule_relationship ?? "") ||
      CANCELED.has(d.trip.schedule_relationship ?? ""),
  };
}

export async function getStops(bbox: BBox, modes?: TransportMode[]): Promise<TransitStop[]> {
  const [w, s, e, n] = bbox;
  const params: Record<string, string> = {
    bbox: `${w},${s},${e},${n}`,
    per_page: "100",
  };
  if (modes?.length) {
    // Collect all explicit GTFS route_type values for the requested modes.
    const routeTypes = Object.entries(GTFS_ROUTE_TYPE_MODE)
      .filter(([, value]) => modes.includes(value))
      .map(([routeType]) => routeType);
    if (routeTypes.length) {
      params.served_by_route_types = routeTypes.join(",");
    }
  }
  const data = await tlFetch("/stops", params, "stops");
  if (data === null) return [];
  const { stops } = parseProviderPayload(stopsEnvelope, data, "Transitland stops");
  return parseProviderRecords(stopSchema, stops, "Transitland stops").map(normalizeStop);
}

export async function getStop(id: string): Promise<TransitStop | null> {
  const onestopId = id.startsWith("tl:") ? id.slice(3) : id;
  const data = await tlFetch("/stops", { onestop_id: onestopId }, "stop");
  if (data === null) return null;
  const { stops } = parseProviderPayload(stopsEnvelope, data, "Transitland stop");
  if (stops.length === 0) return null;
  return normalizeStop(parseProviderPayload(stopSchema, stops[0], "Transitland stop"));
}

export async function getDepartures(stopId: string, minutes = 60): Promise<Departure[]> {
  const onestopId = stopId.startsWith("tl:") ? stopId.slice(3) : stopId;
  // A failed or malformed board throws; it must not read as "no departures".
  const data = await tlFetch(
    `/stops/${encodeURIComponent(onestopId)}/departures`,
    { next: String(minutes * 60) },
    "timetable",
  );
  if (data === null) return [];
  const { stops } = parseProviderPayload(departuresEnvelope, data, "Transitland departures");
  const stop = stops[0];
  if (!stop) return [];
  const platform = stop.platform_code ?? undefined;
  return parseProviderRecords(departureSchema, stop.departures, "Transitland departures").map((d) =>
    normalizeDeparture(d, platform),
  );
}

export async function getRoutes(opts: { bbox?: BBox; stopId?: string }): Promise<TransitRoute[]> {
  const params: Record<string, string> = { per_page: "100" };
  if (opts.bbox) {
    const [w, s, e, n] = opts.bbox;
    params.bbox = `${w},${s},${e},${n}`;
  }
  if (opts.stopId) {
    const id = opts.stopId.startsWith("tl:") ? opts.stopId.slice(3) : opts.stopId;
    params.served_by_stops = id;
  }
  const data = await tlFetch("/routes", params, "routes");
  if (data === null) return [];
  const { routes } = parseProviderPayload(routesEnvelope, data, "Transitland routes");
  return parseProviderRecords(routeSchema, routes, "Transitland routes").map(normalizeRoute);
}

export async function getRoute(id: string): Promise<TransitRoute | null> {
  const onestopId = id.startsWith("tl:") ? id.slice(3) : id;
  const data = await tlFetch(
    "/routes",
    { onestop_id: onestopId, include_geometry: "true" },
    "route",
  );
  if (data === null) return null;
  const { routes } = parseProviderPayload(routesEnvelope, data, "Transitland route");
  if (routes.length === 0) return null;
  return normalizeRoute(parseProviderPayload(routeSchema, routes[0], "Transitland route"));
}
