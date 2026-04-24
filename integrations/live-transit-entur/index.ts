import type {
  LiveTransitProvider,
  LiveTransitVehicle,
} from "@integrations/overlay-live-transit/types.js";
import type {
  AlertSeverity,
  BBox,
  IntegrationContext,
  ServiceAlert,
  TransportMode,
} from "@openmapx/core";

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface EnturVehicle {
  vehicleId?: string | null;
  lastUpdated?: string | null;
  bearing?: number | null;
  speed?: number | null;
  monitored?: boolean | null;
  mode?: string | null;
  line?: {
    lineRef?: string | null;
    lineName?: string | null;
    publicCode?: string | null;
  } | null;
  serviceJourney?: {
    id?: string | null;
    date?: string | null;
  } | null;
  operator?: {
    name?: string | null;
  } | null;
  location?: {
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  monitoredCall?: {
    stopPointRef?: string | null;
    order?: number | null;
  } | null;
}

interface EnturMultilingualText {
  value?: string | null;
  language?: string | null;
}

interface EnturSituation {
  id: string;
  summary?: EnturMultilingualText[] | null;
  description?: EnturMultilingualText[] | null;
  reportType?: string | null;
  severity?: string | null;
  validityPeriod?: {
    startTime?: string | null;
    endTime?: string | null;
  } | null;
  lines?: Array<{ id?: string | null } | null> | null;
  stopPlaces?: Array<{
    id?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null> | null;
  quays?: Array<{
    id?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    stopPlace?: {
      id?: string | null;
      latitude?: number | null;
      longitude?: number | null;
    } | null;
  } | null> | null;
}

const DEFAULT_CLIENT_NAME = "openmapx-server";
const DEFAULT_JOURNEY_PLANNER_ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
const DEFAULT_VEHICLES_ENDPOINT = "https://api.entur.io/realtime/v2/vehicles/graphql";
const NORWAY_BBOX: BBox = [4.0, 57.0, 32.0, 71.5];
const ENTUR_PREFIX = "entur:";
const VEHICLE_SOURCE_ID = "entur-live-vehicles";

const VEHICLES_BY_BBOX_QUERY = `
query VehiclesByBoundingBox(
  $minLat: Float!
  $minLon: Float!
  $maxLat: Float!
  $maxLon: Float!
  $maxDataAge: Duration!
) {
  vehicles(
    boundingBox: { minLat: $minLat, minLon: $minLon, maxLat: $maxLat, maxLon: $maxLon }
    maxDataAge: $maxDataAge
    monitored: true
  ) {
    vehicleId
    lastUpdated
    bearing
    speed
    monitored
    mode
    line { lineRef lineName publicCode }
    serviceJourney { id date }
    operator { name }
    location { latitude longitude }
    monitoredCall { stopPointRef order }
  }
}`;

const HEALTHCHECK_QUERY = `
query HealthCheck {
  vehicles(codespaceId: "RUT", maxDataAge: "PT1H", monitored: true) {
    lastUpdated
  }
}`;

const NATIONAL_SITUATIONS_QUERY = `
{
  situations {
    id
    summary { value language }
    description { value language }
    reportType
    severity
    validityPeriod { startTime endTime }
    lines { id }
    stopPlaces { id latitude longitude }
    quays {
      id
      latitude
      longitude
      stopPlace { id latitude longitude }
    }
  }
}`;

let clientName = DEFAULT_CLIENT_NAME;
let journeyPlannerEndpoint = DEFAULT_JOURNEY_PLANNER_ENDPOINT;
let vehiclesEndpoint = DEFAULT_VEHICLES_ENDPOINT;

function withEnturPrefix(id: string): string {
  return `${ENTUR_PREFIX}${id}`;
}

function encodeServiceJourneyId(serviceJourneyId: string, date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return withEnturPrefix(`${date}|${serviceJourneyId}`);
  }
  return withEnturPrefix(serviceJourneyId);
}

function isTruthyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractCodespaceId(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (!isTruthyString(value)) continue;
    const match = /^([A-Za-z0-9_]+):/.exec(value);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function toTransportMode(raw: string | null | undefined): TransportMode {
  const normalized = (raw ?? "").toLowerCase();
  if (normalized === "rail") return "rail";
  if (normalized === "metro" || normalized === "subway") return "subway";
  if (normalized === "tram") return "tram";
  if (normalized === "bus" || normalized === "coach") return "bus";
  if (normalized === "water" || normalized === "ferry") return "ferry";
  if (normalized === "lift") return "gondola";
  if (normalized === "funicular") return "funicular";
  if (normalized === "cableway" || normalized === "cablecar" || normalized === "cable_car")
    return "cable_car";
  if (normalized === "monorail") return "monorail";
  return "bus";
}

function pickLocalizedText(values: EnturMultilingualText[] | null | undefined): string | undefined {
  if (!values?.length) return undefined;
  const english = values.find((entry) => entry.language?.toLowerCase() === "en" && entry.value);
  if (english?.value) return english.value;
  const norwegian = values.find((entry) => {
    const language = entry.language?.toLowerCase();
    return (language === "nb" || language === "nn" || language === "no") && entry.value;
  });
  if (norwegian?.value) return norwegian.value;
  return values.find((entry) => entry.value)?.value ?? undefined;
}

function toAlertSeverity(raw: string | null | undefined): AlertSeverity {
  const normalized = (raw ?? "").toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "verysevere" || normalized === "severe") return "severe";
  if (normalized === "warning" || normalized === "normal") return "warning";
  return "info";
}

function isInsideBbox(bbox: BBox, longitude: number, latitude: number): boolean {
  return longitude >= bbox[0] && longitude <= bbox[2] && latitude >= bbox[1] && latitude <= bbox[3];
}

async function fetchGraphQl<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ET-Client-Name": clientName,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`Entur GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GraphQlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((entry) => entry.message)
        .filter(Boolean)
        .join("; "),
    );
  }
  if (!payload.data) {
    throw new Error("Entur GraphQL response missing data");
  }
  return payload.data;
}

function toLiveVehicle(vehicle: EnturVehicle): LiveTransitVehicle | null {
  if (
    typeof vehicle.location?.latitude !== "number" ||
    typeof vehicle.location?.longitude !== "number" ||
    !isTruthyString(vehicle.lastUpdated)
  ) {
    return null;
  }

  const rawVehicleId =
    vehicle.vehicleId ??
    vehicle.serviceJourney?.id ??
    `${vehicle.location.latitude}:${vehicle.location.longitude}`;
  const displayLabel =
    vehicle.line?.publicCode ?? vehicle.vehicleId ?? vehicle.line?.lineName ?? "Transit";
  const secondaryLabel =
    vehicle.line?.lineName ?? vehicle.operator?.name ?? vehicle.serviceJourney?.id ?? undefined;
  const routeId = vehicle.line?.lineRef ? withEnturPrefix(vehicle.line.lineRef) : undefined;
  const tripId = vehicle.serviceJourney?.id
    ? encodeServiceJourneyId(vehicle.serviceJourney.id, vehicle.serviceJourney.date ?? undefined)
    : undefined;
  const codespaceId = extractCodespaceId(
    vehicle.line?.lineRef,
    vehicle.serviceJourney?.id,
    vehicle.monitoredCall?.stopPointRef,
  );

  return {
    id: `${VEHICLE_SOURCE_ID}:${rawVehicleId}`,
    provider: VEHICLE_SOURCE_ID,
    sourceId: VEHICLE_SOURCE_ID,
    mode: toTransportMode(vehicle.mode),
    displayLabel,
    secondaryLabel,
    codespaceId,
    tripId,
    routeId,
    lat: vehicle.location.latitude,
    lng: vehicle.location.longitude,
    bearing: vehicle.bearing ?? undefined,
    speed: vehicle.speed ?? undefined,
    label: secondaryLabel ? `${displayLabel}\n${secondaryLabel}` : displayLabel,
    currentStopId: vehicle.monitoredCall?.stopPointRef
      ? withEnturPrefix(vehicle.monitoredCall.stopPointRef)
      : undefined,
    currentStopSequence: vehicle.monitoredCall?.order ?? undefined,
    updatedAt: vehicle.lastUpdated,
  };
}

function toAlert(situation: EnturSituation): ServiceAlert | null {
  if (!situation.id) return null;

  const affectedRouteIds = new Set<string>();
  const affectedStopIds = new Set<string>();

  for (const line of situation.lines ?? []) {
    if (line?.id) affectedRouteIds.add(withEnturPrefix(line.id));
  }
  for (const stopPlace of situation.stopPlaces ?? []) {
    if (stopPlace?.id) affectedStopIds.add(withEnturPrefix(stopPlace.id));
  }
  for (const quay of situation.quays ?? []) {
    if (quay?.id) affectedStopIds.add(withEnturPrefix(quay.id));
    if (quay?.stopPlace?.id) affectedStopIds.add(withEnturPrefix(quay.stopPlace.id));
  }

  return {
    id: withEnturPrefix(situation.id),
    providers: ["entur"],
    severity: toAlertSeverity(situation.severity),
    effect: situation.reportType ?? undefined,
    title:
      pickLocalizedText(situation.summary) ??
      pickLocalizedText(situation.description) ??
      "Service alert",
    description: pickLocalizedText(situation.description),
    affectedRouteIds: [...affectedRouteIds],
    affectedStopIds: [...affectedStopIds],
    activePeriods: situation.validityPeriod?.startTime
      ? [
          {
            start: situation.validityPeriod.startTime,
            end: situation.validityPeriod.endTime ?? undefined,
          },
        ]
      : [],
  };
}

function situationTouchesBbox(situation: EnturSituation, bbox: BBox): boolean {
  for (const stopPlace of situation.stopPlaces ?? []) {
    if (
      typeof stopPlace?.latitude === "number" &&
      typeof stopPlace.longitude === "number" &&
      isInsideBbox(bbox, stopPlace.longitude, stopPlace.latitude)
    ) {
      return true;
    }
  }

  for (const quay of situation.quays ?? []) {
    if (
      typeof quay?.latitude === "number" &&
      typeof quay.longitude === "number" &&
      isInsideBbox(bbox, quay.longitude, quay.latitude)
    ) {
      return true;
    }
    if (
      typeof quay?.stopPlace?.latitude === "number" &&
      typeof quay.stopPlace.longitude === "number" &&
      isInsideBbox(bbox, quay.stopPlace.longitude, quay.stopPlace.latitude)
    ) {
      return true;
    }
  }

  return false;
}

async function getEnturVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
  const data = await fetchGraphQl<{ vehicles?: EnturVehicle[] | null }>(
    vehiclesEndpoint,
    VEHICLES_BY_BBOX_QUERY,
    {
      minLat: bbox[1],
      minLon: bbox[0],
      maxLat: bbox[3],
      maxLon: bbox[2],
      maxDataAge: "PT30M",
    },
  );

  return (data.vehicles ?? [])
    .map((vehicle) => toLiveVehicle(vehicle))
    .filter((vehicle): vehicle is LiveTransitVehicle => vehicle !== null);
}

async function getEnturAlerts(bbox: BBox): Promise<ServiceAlert[]> {
  const data = await fetchGraphQl<{ situations?: EnturSituation[] | null }>(
    journeyPlannerEndpoint,
    NATIONAL_SITUATIONS_QUERY,
  );

  const byId = new Map<string, ServiceAlert>();
  for (const situation of data.situations ?? []) {
    if (!situationTouchesBbox(situation, bbox)) continue;
    const alert = toAlert(situation);
    if (!alert) continue;
    byId.set(alert.id, alert);
  }
  return [...byId.values()];
}

async function isEnturLiveTransitAvailable(): Promise<boolean> {
  try {
    await fetchGraphQl<{ vehicles?: Array<{ lastUpdated?: string | null }> | null }>(
      vehiclesEndpoint,
      HEALTHCHECK_QUERY,
    );
    return true;
  } catch {
    return false;
  }
}

export function setup(ctx: IntegrationContext): void {
  clientName =
    ctx.config.clientName && String(ctx.config.clientName).trim().length > 0
      ? String(ctx.config.clientName).trim()
      : DEFAULT_CLIENT_NAME;
  journeyPlannerEndpoint =
    ctx.config.journeyPlannerEndpoint && String(ctx.config.journeyPlannerEndpoint).trim().length > 0
      ? String(ctx.config.journeyPlannerEndpoint).trim()
      : DEFAULT_JOURNEY_PLANNER_ENDPOINT;
  vehiclesEndpoint =
    ctx.config.vehiclesEndpoint && String(ctx.config.vehiclesEndpoint).trim().length > 0
      ? String(ctx.config.vehiclesEndpoint).trim()
      : DEFAULT_VEHICLES_ENDPOINT;

  ctx.registerHealthCheck(async () => {
    const available = await isEnturLiveTransitAvailable();
    return available
      ? { status: "up" as const }
      : { status: "down" as const, error: "Entur realtime vehicle probe failed" };
  });

  const provider: LiveTransitProvider = {
    id: "live-transit-entur",
    priority: 10,
    coverage: { bbox: NORWAY_BBOX },
    getVehicles: (bbox: BBox) => getEnturVehicles(bbox),
    getAlerts: (bbox: BBox) => getEnturAlerts(bbox),
  };

  ctx.registerProvider("live-transit", provider);
}
