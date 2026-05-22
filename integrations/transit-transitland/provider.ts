import type { BBox } from "@openmapx/core";
import type {
  Departure,
  TransitRoute,
  TransitStop,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import { GTFS_ROUTE_TYPE_MODE, mapGtfsRouteTypeToMode } from "@openmapx/mobility-formats";

const BASE_URL = "https://transit.land/api/v2/rest";

// Populated by setup(ctx) from the resolved integration config cascade.
let transitlandApiKey: string | null = null;
export function setTransitlandApiKey(value: string | undefined): void {
  transitlandApiKey = value && value.length > 0 ? value : null;
}

function apiKey(): string | null {
  return transitlandApiKey;
}

async function tlFetch<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apikey", key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TransitLand ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function mapModes(routeTypes?: number[]): TransportMode[] {
  if (!routeTypes?.length) return ["bus"];
  return routeTypes.map((t) => mapGtfsRouteTypeToMode(t));
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeStop(s: any): TransitStop {
  const [lng, lat] = s.geometry?.coordinates ?? [0, 0];
  const routeTypes: number[] =
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    s.route_stops?.map((rs: any) => rs.route?.route_type) ?? [];
  return {
    id: `tl:${s.onestop_id}`,
    name: s.stop_name ?? s.name ?? "Unknown",
    lat,
    lng,
    modes: mapModes(routeTypes),
    platformCode: s.platform_code ?? undefined,
    parentStationId: s.parent_station_onestop_id ? `tl:${s.parent_station_onestop_id}` : undefined,
    provider: "transitland",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeRoute(r: any): TransitRoute {
  const mode: TransportMode = mapGtfsRouteTypeToMode(r.route_type as number);
  const color = r.route_color ? r.route_color.replace(/^#/, "") : undefined;
  const textColor = r.route_text_color ? r.route_text_color.replace(/^#/, "") : undefined;
  return {
    id: `tl:${r.onestop_id}`,
    shortName: r.route_short_name ?? r.route_long_name ?? "",
    longName: r.route_long_name ?? r.route_short_name ?? "",
    mode,
    color,
    textColor,
    operatorName: r.operator?.name ?? r.agency?.agency_name ?? "",
    geometry: r.geometry ?? undefined,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeDeparture(d: any): Departure {
  const route = d.trip?.route ?? d.route ?? {};
  const mode: TransportMode = mapGtfsRouteTypeToMode(route.route_type as number);
  const color = route.route_color ? route.route_color.replace(/^#/, "") : undefined;
  const scheduled = d.departure_time as string;
  const expected = d.departure_time_actual as string | undefined;
  const delaySeconds =
    scheduled && expected
      ? Math.round((new Date(expected).getTime() - new Date(scheduled).getTime()) / 1000)
      : undefined;
  return {
    tripId: d.trip?.trip_id ?? d.trip_id ?? "",
    route: {
      id: route.onestop_id ? `tl:${route.onestop_id}` : "",
      shortName: route.route_short_name ?? "",
      longName: route.route_long_name ?? "",
      mode,
      color,
    },
    headsign: d.trip?.trip_headsign ?? d.headsign ?? "",
    scheduledAt: scheduled,
    expectedAt: expected,
    delaySeconds: delaySeconds !== undefined && delaySeconds !== 0 ? delaySeconds : undefined,
    platform: d.stop_time?.stop?.platform_code ?? undefined,
    canceled: false,
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
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = await tlFetch<{ stops: any[] }>("/stops", params);
    return (data?.stops ?? []).map(normalizeStop);
  } catch {
    return [];
  }
}

export async function getStop(id: string): Promise<TransitStop | null> {
  const onestopId = id.startsWith("tl:") ? id.slice(3) : id;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = await tlFetch<{ stops: any[] }>(`/stops`, { onestop_id: onestopId });
    const stop = data?.stops?.[0];
    return stop ? normalizeStop(stop) : null;
  } catch {
    return null;
  }
}

export async function getDepartures(stopId: string, minutes = 60): Promise<Departure[]> {
  const onestopId = stopId.startsWith("tl:") ? stopId.slice(3) : stopId;
  try {
    const data = await tlFetch<{ stops: { departures: unknown[] }[] }>(
      `/stops/${onestopId}/departures`,
      { next: String(minutes * 60) },
    );
    const departures = data?.stops?.[0]?.departures ?? [];
    return departures.map((d) => normalizeDeparture(d));
  } catch {
    return [];
  }
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
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = await tlFetch<{ routes: any[] }>("/routes", params);
    return (data?.routes ?? []).map(normalizeRoute);
  } catch {
    return [];
  }
}

export async function getRoute(id: string): Promise<TransitRoute | null> {
  const onestopId = id.startsWith("tl:") ? id.slice(3) : id;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = await tlFetch<{ routes: any[] }>(`/routes`, {
      onestop_id: onestopId,
      include_geometry: "true",
    });
    const route = data?.routes?.[0];
    return route ? normalizeRoute(route) : null;
  } catch {
    return null;
  }
}
