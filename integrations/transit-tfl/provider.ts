import { FetchJsonHttpError, fetchJson } from "@openmapx/core";
import {
  ProviderInputError,
  parseProviderPayload,
  parseProviderRecords,
} from "@openmapx/integration-framework";
import { oldestDataAsOf, upstreamDataAsOf } from "@openmapx/mobility-core/freshness";
import type {
  AlertSeverity,
  Departure,
  DepartureBoard,
  RouteStop,
  ServiceAlert,
  TransitStop,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import { z } from "zod";

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

/**
 * Fetch a TfL resource whose failure must not read as "nothing here". Request
 * URLs carry the app key, so the upstream error stays on the cause, where
 * provider health reads its status, and out of the message.
 */
async function tflJson(url: string, what: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await fetchJson<unknown>(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`TfL ${what} unavailable`, { cause: error });
  }
}

/**
 * Fetch a TfL resource whose path carries an identifier the caller supplied.
 * A 404 there means TfL does not know that identifier: bad caller input, which
 * must not count against TfL's health.
 */
async function tflKeyedJson(url: string, what: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await tflJson(url, what, signal);
  } catch (error) {
    if (isNotFound(error))
      throw new ProviderInputError(`Unknown TfL ${what} identifier`, { cause: error });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof FetchJsonHttpError
    ? error.cause.status === 404
    : false;
}

function mapTflMode(modeName: string): TransportMode {
  return MODE_MAP[modeName] ?? "bus";
}

const optionalText = z.string().nullish();
const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);

/** StopPoint and search-match fields the adapter maps; coordinates are required. */
const stopPointSchema = z
  .object({
    naptanId: optionalText,
    id: optionalText,
    commonName: optionalText,
    name: optionalText,
    lat: latitude,
    lon: longitude,
    modes: z.array(z.string()).nullish(),
    platformCode: optionalText,
  })
  .refine((stop) => Boolean(stop.naptanId || stop.id), { message: "stop has no identifier" });
type TflStopPoint = z.infer<typeof stopPointSchema>;

const lineStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  lineStatuses: z
    .array(
      z.object({
        statusSeverity: z.number().nullish(),
        statusSeverityDescription: optionalText,
        reason: optionalText,
      }),
    )
    .nullish(),
});
type TflLineStatus = z.infer<typeof lineStatusSchema>;

const sequenceStopSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  lat: latitude,
  lon: longitude,
});

const disruptionSchema = z.object({
  category: optionalText,
  categoryDescription: optionalText,
  description: optionalText,
  additionalInfo: optionalText,
  disruptedRouteId: optionalText,
});

/** A live prediction; TfL publishes no scheduled time, only the expected one. */
const predictionSchema = z.object({
  vehicleId: optionalText,
  lineId: optionalText,
  lineName: optionalText,
  modeName: optionalText,
  destinationName: optionalText,
  towards: optionalText,
  platformName: optionalText,
  timeToStation: z.number().finite(),
  expectedArrival: z.iso.datetime({ offset: true }),
  timestamp: optionalText,
});

function modesFromStopPoint(s: TflStopPoint): TransportMode[] {
  // s.modes is the authoritative list of transport modes for this stop point
  if (!s.modes?.length) return ["bus"];
  const unique = [...new Set(s.modes.map(mapTflMode))];
  return unique.length ? unique : ["bus"];
}

function normalizeStop(s: TflStopPoint): TransitStop {
  const naptanId = s.naptanId?.trim() ?? "";
  return {
    id: `tfl:${s.naptanId ?? s.id}`,
    ...(naptanId ? { codes: [{ value: naptanId, namespace: "naptan" as const }] } : {}),
    name: s.commonName ?? s.name ?? "Unknown",
    lat: s.lat,
    lng: s.lon,
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

  const data = await tflJson(`${BASE_URL}/StopPoint?${params}`, "nearby stops");
  const { stopPoints } = parseProviderPayload(
    z.object({ stopPoints: z.array(z.unknown()) }),
    data,
    "TfL nearby stops",
  );
  return parseProviderRecords(stopPointSchema, stopPoints, "TfL nearby stops").map(normalizeStop);
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  const key = apiKey();
  if (!key) return null;
  const naptanId = stopId.startsWith("tfl:") ? stopId.slice(4) : stopId;
  const params = new URLSearchParams({ app_key: key });
  let data: unknown;
  try {
    data = await tflJson(`${BASE_URL}/StopPoint/${encodeURIComponent(naptanId)}?${params}`, "stop");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return normalizeStop(parseProviderPayload(stopPointSchema, data, "TfL stop"));
}

export async function searchByName(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<TransitStop[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({
    maxResults: String(Math.min(limit, 50)),
    app_key: key,
  });
  // Search text is not an identifier: TfL answers unmatched text with no
  // matches, so a 404 here means the endpoint broke and counts as a failure.
  const data = await tflJson(
    `${BASE_URL}/StopPoint/Search/${encodeURIComponent(query)}?${params}`,
    "stop search",
    signal,
  );
  // TfL omits `matches` when nothing matched.
  const { matches } = parseProviderPayload(
    z.object({ matches: z.array(z.unknown()).nullish() }),
    data,
    "TfL stop search",
  );
  return parseProviderRecords(stopPointSchema, matches ?? [], "TfL stop search")
    .slice(0, limit)
    .map(normalizeStop);
}

function mapTflSeverity(severityNumber: number): AlertSeverity {
  if (severityNumber >= 9) return "info";
  if (severityNumber >= 5) return "warning";
  if (severityNumber >= 1) return "severe";
  return "critical";
}

function lineToAlert(line: TflLineStatus): ServiceAlert | null {
  const status = line.lineStatuses?.[0];
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

async function lineAlerts(
  url: string,
  what: string,
  callerKeyed: boolean,
): Promise<ServiceAlert[]> {
  const data = callerKeyed ? await tflKeyedJson(url, what) : await tflJson(url, what);
  const lines = parseProviderPayload(z.array(z.unknown()), data, `TfL ${what}`);
  const alerts: ServiceAlert[] = [];
  for (const line of parseProviderRecords(lineStatusSchema, lines, `TfL ${what}`)) {
    const alert = lineToAlert(line);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

export async function getAlerts(): Promise<ServiceAlert[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({ app_key: key });
  return lineAlerts(
    `${BASE_URL}/Line/Mode/tube,dlr,elizabeth-line,overground,tram/Status?${params}`,
    "line status",
    false,
  );
}

export async function getRouteAlerts(lineId: string): Promise<ServiceAlert[]> {
  const key = apiKey();
  if (!key) return [];
  const rawId = lineId.startsWith("tfl:") ? lineId.slice(4) : lineId;
  const params = new URLSearchParams({ app_key: key });
  return lineAlerts(
    `${BASE_URL}/Line/${encodeURIComponent(rawId)}/Status?${params}`,
    "line status",
    true,
  );
}

export async function getRouteStopSequence(lineId: string): Promise<RouteStop[]> {
  const key = apiKey();
  if (!key) return [];
  const rawId = lineId.startsWith("tfl:") ? lineId.slice(4) : lineId;

  const params = new URLSearchParams({ app_key: key });
  const data = await tflKeyedJson(
    `${BASE_URL}/Line/${encodeURIComponent(rawId)}/Route/Sequence/outbound?${params}`,
    "route sequence",
  );
  const { stopPointSequences } = parseProviderPayload(
    z.object({ stopPointSequences: z.array(z.object({ stopPoint: z.array(z.unknown()) })) }),
    data,
    "TfL route sequence",
  );
  // A sequence is one ordered path; a stop without coordinates breaks it.
  const stops = parseProviderPayload(
    z.array(sequenceStopSchema),
    stopPointSequences[0]?.stopPoint ?? [],
    "TfL route sequence",
  );
  return stops.map(
    (s, index): RouteStop => ({
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
  const data = await tflKeyedJson(
    `${BASE_URL}/StopPoint/${encodeURIComponent(naptanId)}/Disruption?${params}`,
    "stop alerts",
  );
  const disruptions = parseProviderPayload(z.array(z.unknown()), data, "TfL stop alerts");
  return parseProviderRecords(disruptionSchema, disruptions, "TfL stop alerts")
    .map((d): ServiceAlert => {
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
    })
    .filter((a) => a.title);
}

/**
 * Live arrival predictions at a stop. Each prediction carries the time TfL made
 * it; the board's age is the oldest of them.
 */
export async function getDepartures(stopId: string, minutes: number): Promise<DepartureBoard> {
  const key = apiKey();
  if (!key) return { departures: [] };

  const naptanId = stopId.startsWith("tfl:") ? stopId.slice(4) : stopId;
  const params = new URLSearchParams({ app_key: key });
  const data = await tflKeyedJson(
    `${BASE_URL}/StopPoint/${encodeURIComponent(naptanId)}/Arrivals?${params}`,
    "timetable",
  );
  const arrivals = parseProviderPayload(z.array(z.unknown()), data, "TfL timetable");
  const cutoff = minutes * 60;
  const inWindow = parseProviderRecords(predictionSchema, arrivals, "TfL timetable")
    // Filter to the requested time window
    .filter((arr) => arr.timeToStation <= cutoff)
    // Sort ascending by arrival time
    .sort((a, b) => a.timeToStation - b.timeToStation);
  const dataAsOf = oldestDataAsOf(inWindow.map((arr) => upstreamDataAsOf(arr.timestamp)));
  return {
    ...(dataAsOf ? { dataAsOf } : {}),
    departures: inWindow.map((arr): Departure => {
      const expectedAt = arr.expectedArrival;
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
    }),
  };
}
