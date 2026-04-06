import type {
  Departure,
  Facility,
  GeoJSONLineString,
  GeoJSONMultiLineString,
  RouteStop,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TransportMode,
  VehiclePosition,
} from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";

const BASE_URL = "https://api-v3.mbta.com";

const VEHICLE_TYPE_MAP: Record<number, TransportMode> = {
  0: "tram",
  1: "subway",
  2: "rail",
  3: "bus",
  4: "ferry",
};

function apiKey(): string | null {
  return process.env.MBTA_API_KEY ?? null;
}

function authParams(): URLSearchParams {
  const key = apiKey();
  const params = new URLSearchParams();
  if (key) params.set("api_key", key);
  return params;
}

// biome-ignore lint/suspicious/noExplicitAny: MBTA JSON:API stop resource
function normalizeStop(d: any): TransitStop {
  return {
    id: `mb:${d.id}`,
    name: d.attributes?.name ?? "Unknown",
    lat: d.attributes?.latitude ?? 0,
    lng: d.attributes?.longitude ?? 0,
    modes: [VEHICLE_TYPE_MAP[d.attributes?.vehicle_type as number] ?? "bus"],
    platformCode: d.attributes?.platform_code ?? undefined,
    parentStationId: d.relationships?.parent_station?.data?.id
      ? `mb:${d.relationships.parent_station.data.id}`
      : undefined,
    provider: "mb",
  };
}

function rawId(id: string, prefix = "mb:"): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export async function getStops(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  if (!apiKey()) return [];

  const params = authParams();
  params.set("filter[latitude]", String(lat));
  params.set("filter[longitude]", String(lng));
  params.set("filter[radius]", String(radiusMeters / 1000));

  try {
    const res = await fetch(`${BASE_URL}/stops?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[] };
    return (data.data ?? []).map(normalizeStop);
  } catch {
    return [];
  }
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  if (!apiKey()) return null;
  const id = rawId(stopId);
  try {
    const params = authParams();
    const res = await fetch(`${BASE_URL}/stops/${encodeURIComponent(id)}?${params}`);
    if (!res.ok) return null;
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any };
    return data.data ? normalizeStop(data.data) : null;
  } catch {
    return null;
  }
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  if (!apiKey()) return [];

  const id = rawId(stopId);
  const params = authParams();
  params.set("filter[stop]", id);
  // Include both route (for name/color) and schedule (for scheduled times)
  params.set("include", "route,schedule");

  try {
    const res = await fetch(`${BASE_URL}/predictions?${params}`);
    if (!res.ok) return [];

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[]; included?: any[] };

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const routesById = new Map<string, any>();
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const schedulesById = new Map<string, any>();
    for (const item of data.included ?? []) {
      if (item.type === "route") routesById.set(item.id, item.attributes);
      if (item.type === "schedule") schedulesById.set(item.id, item.attributes);
    }

    const cutoff = new Date(Date.now() + minutes * 60 * 1000);

    return (
      (data.data ?? [])
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        .filter((pred: any) => {
          const t = pred.attributes?.departure_time ?? pred.attributes?.arrival_time;
          if (!t) return false;
          return new Date(t) <= cutoff;
        })
        .map(
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          (pred: any): Departure => {
            const routeId = pred.relationships?.route?.data?.id ?? "";
            const schedId = pred.relationships?.schedule?.data?.id ?? "";
            const routeAttrs = routesById.get(routeId);
            const schedAttrs = schedulesById.get(schedId);
            const mode: TransportMode = VEHICLE_TYPE_MAP[routeAttrs?.type as number] ?? "bus";
            const color = routeAttrs?.color ? routeAttrs.color.replace(/^#/, "") : undefined;

            // `departure_time` from predictions is the realtime expected time
            const expectedAt: string | undefined =
              pred.attributes?.departure_time ?? pred.attributes?.arrival_time ?? undefined;
            // Use schedule's departure_time if available for the scheduled time
            const scheduledAt: string =
              schedAttrs?.departure_time ?? schedAttrs?.arrival_time ?? expectedAt ?? "";

            const delaySeconds =
              expectedAt && scheduledAt
                ? Math.round(
                    (new Date(expectedAt).getTime() - new Date(scheduledAt).getTime()) / 1000,
                  )
                : undefined;

            const rel = pred.attributes?.schedule_relationship;
            const canceled = rel === "CANCELLED" || rel === "SKIPPED";

            return {
              tripId: pred.relationships?.trip?.data?.id ?? "",
              route: {
                id: `mb:${routeId}`,
                shortName: routeAttrs?.short_name ?? routeId,
                longName: routeAttrs?.long_name ?? "",
                mode,
                color,
              },
              headsign: pred.attributes?.headsign ?? "",
              scheduledAt,
              expectedAt: expectedAt !== scheduledAt ? expectedAt : undefined,
              delaySeconds: delaySeconds && delaySeconds !== 0 ? delaySeconds : undefined,
              platform: pred.attributes?.departure_boarding_area ?? undefined,
              canceled,
            };
          },
        )
    );
  } catch {
    return [];
  }
}

function mapMbtaSeverity(severity: number): "info" | "warning" | "severe" | "critical" {
  if (severity <= 3) return "info";
  if (severity <= 6) return "warning";
  if (severity <= 9) return "severe";
  return "critical";
}

export async function getAlerts(opts?: {
  stopId?: string;
  routeId?: string;
}): Promise<ServiceAlert[]> {
  const params = authParams();
  params.set("filter[activity]", "BOARD");
  if (opts?.stopId) params.set("filter[stop]", rawId(opts.stopId));
  if (opts?.routeId) params.set("filter[route]", rawId(opts.routeId));

  try {
    const res = await fetch(`${BASE_URL}/alerts?${params}`);
    if (!res.ok) return [];

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[] };
    return (data.data ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (a: any): ServiceAlert => ({
        id: `mb:${a.id}`,
        providers: ["mb"],
        severity: mapMbtaSeverity(a.attributes?.severity ?? 1),
        effect: a.attributes?.effect ?? undefined,
        title: a.attributes?.header ?? "",
        description: a.attributes?.description ?? undefined,
        affectedRouteIds: (a.attributes?.informed_entity ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .filter((e: any) => e.route)
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .map((e: any) => `mb:${e.route}`),
        affectedStopIds: (a.attributes?.informed_entity ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .filter((e: any) => e.stop)
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .map((e: any) => `mb:${e.stop}`),
        activePeriods:
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          a.attributes?.active_period?.map((p: any) => ({
            start: p.start,
            end: p.end ?? undefined,
          })) ?? [],
      }),
    );
  } catch {
    return [];
  }
}

export async function getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
  const id = rawId(routeId);
  const params = authParams();
  params.set("filter[route]", id);

  try {
    const res = await fetch(`${BASE_URL}/vehicles?${params}`);
    if (!res.ok) return [];

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[] };
    return (data.data ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (v: any): VehiclePosition => ({
        id: `mb:${v.id}`,
        provider: "mb",
        lat: v.attributes?.latitude ?? 0,
        lng: v.attributes?.longitude ?? 0,
        bearing: v.attributes?.bearing ?? undefined,
        speed: v.attributes?.speed ?? undefined,
        label: v.attributes?.label ?? undefined,
        tripId: v.relationships?.trip?.data?.id ? `mb:${v.relationships.trip.data.id}` : undefined,
        routeId: `mb:${id}`,
        currentStopId: v.relationships?.stop?.data?.id
          ? `mb:${v.relationships.stop.data.id}`
          : undefined,
        currentStopSequence: v.attributes?.current_stop_sequence ?? undefined,
        updatedAt: v.attributes?.updated_at ?? new Date().toISOString(),
      }),
    );
  } catch {
    return [];
  }
}

export async function getRouteShape(
  routeId: string,
): Promise<GeoJSONLineString | GeoJSONMultiLineString | undefined> {
  try {
    const id = rawId(routeId);
    const params = authParams();
    params.set("filter[route]", id);

    const res = await fetch(`${BASE_URL}/shapes?${params}`);
    if (!res.ok) return undefined;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[] };
    const shapes = (data.data ?? [])
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      .filter((s: any) => (s.attributes?.priority ?? -1) >= 0)
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      .sort((a: any, b: any) => (b.attributes?.priority ?? 0) - (a.attributes?.priority ?? 0));

    if (shapes.length === 0) return undefined;

    if (shapes.length === 1) {
      const coords = decodePolyline(shapes[0].attributes?.polyline ?? "");
      return { type: "LineString", coordinates: coords };
    }

    return {
      type: "MultiLineString",
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      coordinates: shapes.map((s: any) => decodePolyline(s.attributes?.polyline ?? "")),
    };
  } catch {
    return undefined;
  }
}

export async function getRoute(routeId: string): Promise<TransitRoute | null> {
  try {
    const id = rawId(routeId);
    const params = authParams();
    const [res, shape] = await Promise.all([
      fetch(`${BASE_URL}/routes/${encodeURIComponent(id)}?${params}`),
      getRouteShape(id),
    ]);
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any };
    if (!data.data) return null;

    const attrs = data.data.attributes;
    return {
      id: `mb:${routeId}`,
      shortName: attrs?.short_name || attrs?.long_name || routeId,
      longName: attrs?.long_name ?? routeId,
      mode: VEHICLE_TYPE_MAP[attrs?.type as number] ?? "bus",
      color: attrs?.color ? attrs.color.replace(/^#/, "") : undefined,
      textColor: attrs?.text_color ? attrs.text_color.replace(/^#/, "") : undefined,
      operatorName: "MBTA",
      geometry: shape ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function getRouteStops(routeId: string): Promise<RouteStop[]> {
  const id = rawId(routeId);
  const params = authParams();
  params.set("filter[route]", id);

  try {
    const res = await fetch(`${BASE_URL}/stops?${params}`);
    if (!res.ok) return [];

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { data?: any[] };
    return (data.data ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (d: any, index: number): RouteStop => ({
        id: `mb:${d.id}`,
        name: d.attributes?.name ?? "",
        lat: d.attributes?.latitude ?? 0,
        lng: d.attributes?.longitude ?? 0,
        platformCode: d.attributes?.platform_code ?? undefined,
        sequence: index,
      }),
    );
  } catch {
    return [];
  }
}

export async function getFacilities(stopId: string): Promise<Facility[]> {
  const id = rawId(stopId);
  const params = authParams();
  params.set("filter[stop]", id);
  params.set("filter[type]", "ELEVATOR,ESCALATOR");

  const res = await fetch(`${BASE_URL}/facilities?${params}`);
  if (!res.ok) return [];

  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = (await res.json()) as { data?: any[] };
  return (data.data ?? []).map(
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    (f: any): Facility => {
      const fType = f.attributes?.type;
      const type: Facility["type"] =
        fType === "ELEVATOR" ? "elevator" : fType === "ESCALATOR" ? "escalator" : "other";
      const accessProp = (f.attributes?.properties ?? []).find(
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        (p: any) => p.name === "accessibility-accessible",
      );
      const isAccessible = accessProp ? accessProp.value === 1 : true;
      return {
        id: `mb:${f.id}`,
        stopId: `mb:${id}`,
        name: f.attributes?.long_name ?? f.attributes?.short_name ?? f.id,
        type,
        isAccessible,
        provider: "mb",
      };
    },
  );
}
