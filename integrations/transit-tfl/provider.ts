import { fetchJson } from "@openmapx/core";
import type {
  AlertSeverity,
  Departure,
  RouteStop,
  ServiceAlert,
  TransitStop,
  TransportMode,
} from "@openmapx/mobility-core/transit";

const BASE_URL = "https://api.tfl.gov.uk";
const MAX_RADIUS = 1000;

const MODE_MAP: Record<string, TransportMode> = {
  tube: "subway",
  dlr: "subway",
  "elizabeth-line": "rail",
  "national-rail": "rail",
  overground: "rail",
  bus: "bus",
  coach: "bus",
  "replacement-bus": "bus",
  tram: "tram",
  "river-bus": "ferry",
  "river-tour": "ferry",
  "cable-car": "cable_car",
};

// Populated by setup(ctx) from the resolved integration config cascade.
let tflApiKey: string | null = null;
export function setTflApiKey(value: string | undefined): void {
  tflApiKey = value && value.length > 0 ? value : null;
}

function apiKey(): string | null {
  return tflApiKey;
}

function mapTflMode(modeName: string): TransportMode {
  return MODE_MAP[modeName] ?? "bus";
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function modesFromStopPoint(s: any): TransportMode[] {
  // s.modes is the authoritative list of transport modes for this stop point
  const modes = s.modes as string[] | undefined;
  if (!modes?.length) return ["bus"];
  const mapped = modes.map(mapTflMode);
  const unique = [...new Set(mapped)];
  return unique.length ? unique : ["bus"];
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeStop(s: any): TransitStop {
  return {
    id: `tfl:${s.naptanId ?? s.id}`,
    name: s.commonName ?? s.name ?? "Unknown",
    lat: s.lat ?? s.latitude ?? 0,
    lng: s.lon ?? s.longitude ?? 0,
    modes: modesFromStopPoint(s),
    platformCode: s.platformCode ?? undefined,
    provider: "tfl",
  };
}

export async function getStops(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  const key = apiKey();
  if (!key) return [];

  const clampedRadius = Math.min(Math.round(radiusMeters), MAX_RADIUS);
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    radius: String(clampedRadius),
    stoptypes: "NaptanMetroStation,NaptanRailStation,NaptanPublicBusCoachTram,NaptanFerryBerth",
    app_key: key,
  });

  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<{ stopPoints?: any[] }>(`${BASE_URL}/StopPoint?${params}`, {
    nullOnError: true,
  });
  return (data?.stopPoints ?? []).map(normalizeStop);
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  const key = apiKey();
  if (!key) return null;
  const naptanId = stopId.startsWith("tfl:") ? stopId.slice(4) : stopId;
  const params = new URLSearchParams({ app_key: key });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<any>(
    `${BASE_URL}/StopPoint/${encodeURIComponent(naptanId)}?${params}`,
    { nullOnError: true },
  );
  return data ? normalizeStop(data) : null;
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({
    maxResults: String(Math.min(limit, 50)),
    app_key: key,
  });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<{ matches?: any[] }>(
    `${BASE_URL}/StopPoint/Search/${encodeURIComponent(query)}?${params}`,
    { nullOnError: true },
  );
  return (data?.matches ?? []).slice(0, limit).map(normalizeStop);
}

function mapTflSeverity(severityNumber: number): AlertSeverity {
  if (severityNumber >= 9) return "info";
  if (severityNumber >= 5) return "warning";
  if (severityNumber >= 1) return "severe";
  return "critical";
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function lineToAlert(line: any): ServiceAlert | null {
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const status = (line.lineStatuses ?? [])[0] as any | undefined;
  if (!status) return null;
  if ((status.statusSeverity ?? 10) >= 10) return null; // Good Service
  return {
    id: `tfl:status:${line.id}`,
    providers: ["tfl"],
    severity: mapTflSeverity(status.statusSeverity ?? 0),
    effect: status.statusSeverityDescription ?? undefined,
    title: `${line.name}: ${status.statusSeverityDescription ?? ""}`,
    description: status.reason ? status.reason.replace(/<[^>]+>/g, "") : undefined,
    affectedRouteIds: [`tfl:${line.id}`],
    affectedStopIds: [],
    activePeriods: [],
  };
}

export async function getAlerts(): Promise<ServiceAlert[]> {
  const key = apiKey();
  if (!key) return [];

  const params = new URLSearchParams({ app_key: key });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<any[]>(
    `${BASE_URL}/Line/Mode/tube,dlr,elizabeth-line,overground,tram/Status?${params}`,
    { nullOnError: true },
  );
  const alerts: ServiceAlert[] = [];
  for (const line of data ?? []) {
    const alert = lineToAlert(line);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

export async function getRouteAlerts(lineId: string): Promise<ServiceAlert[]> {
  const key = apiKey();
  if (!key) return [];

  const rawId = lineId.startsWith("tfl:") ? lineId.slice(4) : lineId;
  const params = new URLSearchParams({ app_key: key });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<any[]>(
    `${BASE_URL}/Line/${encodeURIComponent(rawId)}/Status?${params}`,
    { nullOnError: true },
  );
  const alerts: ServiceAlert[] = [];
  for (const line of data ?? []) {
    const alert = lineToAlert(line);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

export async function getRouteStopSequence(lineId: string): Promise<RouteStop[]> {
  const key = apiKey();
  if (!key) return [];
  const rawId = lineId.startsWith("tfl:") ? lineId.slice(4) : lineId;

  const params = new URLSearchParams({ app_key: key });
  const data = await fetchJson<{
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    stopPointSequences?: any[];
  }>(`${BASE_URL}/Line/${encodeURIComponent(rawId)}/Route/Sequence/outbound?${params}`, {
    nullOnError: true,
  });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const stops: any[] = data?.stopPointSequences?.[0]?.stopPoint ?? [];
  return stops.map(
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    (s: any, index: number): RouteStop => ({
      id: `tfl:${s.id}`,
      name: s.name,
      lat: s.lat,
      lng: s.lon,
      sequence: index,
    }),
  );
}

export async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
  const key = apiKey();
  if (!key) return [];
  const naptanId = stopId.startsWith("tfl:") ? stopId.slice(4) : stopId;
  const params = new URLSearchParams({ app_key: key });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = await fetchJson<any[]>(`${BASE_URL}/StopPoint/${naptanId}/Disruption?${params}`, {
    nullOnError: true,
  });
  if (!Array.isArray(data)) return [];
  return data
    .map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (d: any): ServiceAlert => {
        // Map TfL disruption category to severity
        let severity: AlertSeverity = "warning";
        const cat = (d.category ?? d.categoryDescription ?? "").toLowerCase();
        if (/closure|suspend|cancel/.test(cat)) severity = "severe";
        else if (/information|planned/.test(cat)) severity = "info";

        return {
          id: `tfl:disruption:${naptanId}:${d.disruptedRouteId ?? d.description?.slice(0, 30) ?? "unknown"}`,
          providers: ["tfl"],
          severity,
          title: d.description ?? "Service disruption",
          description: d.additionalInfo ?? undefined,
          affectedRouteIds: d.disruptedRouteId ? [`tfl:${d.disruptedRouteId}`] : [],
          affectedStopIds: [`tfl:${naptanId}`],
          activePeriods: [],
        };
      },
    )
    .filter((a) => a.title);
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const key = apiKey();
  if (!key) return [];

  const naptanId = stopId.startsWith("tfl:") ? stopId.slice(4) : stopId;
  const params = new URLSearchParams({ app_key: key });
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const arrivals = await fetchJson<any[]>(
    `${BASE_URL}/StopPoint/${encodeURIComponent(naptanId)}/Arrivals?${params}`,
    { nullOnError: true },
  );
  const cutoff = minutes * 60;
  return (
    (arrivals ?? [])
      // Filter to the requested time window
      .filter((arr) => (arr.timeToStation ?? 0) <= cutoff)
      // Sort ascending by arrival time
      .sort((a, b) => (a.timeToStation ?? 0) - (b.timeToStation ?? 0))
      .map(
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        (arr: any): Departure => {
          // TfL only provides live arrival predictions — no separate scheduled time
          const expectedAt: string =
            arr.expectedArrival ??
            new Date(Date.now() + (arr.timeToStation ?? 0) * 1000).toISOString();
          return {
            tripId: arr.vehicleId ?? "",
            route: {
              id: `tfl:${arr.lineId ?? ""}`,
              shortName: arr.lineName ?? arr.lineId ?? "",
              longName: arr.lineName ?? "",
              mode: mapTflMode(arr.modeName ?? ""),
            },
            headsign: arr.destinationName ?? arr.towards ?? "",
            // TfL is real-time only; scheduledAt = expectedAt
            scheduledAt: expectedAt,
            expectedAt,
            platform: arr.platformName ?? undefined,
            canceled: false,
          };
        },
      )
  );
}
