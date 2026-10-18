import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";
import { type BBox, fetchJson } from "@openmapx/core";
import {
  captureTransitContributors,
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type {
  AlertSeverity,
  LiveTransitVehicle,
  ServiceAlert,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import {
  NationalSituationsDocument,
  type SituationFieldsFragment,
} from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import { affectedLineIds, affectedStops } from "@openmapx/mobility-formats/entur/situations.js";
import {
  type VehicleFieldsFragment,
  VehicleHealthCheckDocument,
  VehiclesByBoundingBoxDocument,
} from "@openmapx/mobility-formats/entur/vehicles.generated.js";

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

const DEFAULT_CLIENT_NAME = "openmapx-server";
const DEFAULT_JOURNEY_PLANNER_ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
const DEFAULT_VEHICLES_ENDPOINT = "https://api.entur.io/realtime/v2/vehicles/graphql";
const NORWAY_BBOX: BBox = [4.0, 57.0, 32.0, 71.5];
const ENTUR_PREFIX = "entur:";
const VEHICLE_SOURCE_ID = "entur-live-vehicles";

let clientName = DEFAULT_CLIENT_NAME;
let journeyPlannerEndpoint = DEFAULT_JOURNEY_PLANNER_ENDPOINT;
let vehiclesEndpoint = DEFAULT_VEHICLES_ENDPOINT;

// Combined cache budget: national snapshot 15 s + bbox 30 s + HTTP 15 s.
const SITUATIONS_CACHE_MS = 15_000;
interface SituationSnapshot {
  situations: SituationFieldsFragment[];
  fetchedAt: string;
  expiresAt: number;
}
let situationCache: { snapshot?: SituationSnapshot; pending?: Promise<SituationSnapshot> } = {};

function getSituationSnapshot(): Promise<SituationSnapshot> {
  const cache = situationCache;
  if (cache.snapshot && Date.now() < cache.snapshot.expiresAt)
    return Promise.resolve(cache.snapshot);
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    try {
      const data = await fetchGraphQl(journeyPlannerEndpoint, NationalSituationsDocument, {});
      const now = Date.now();
      const snapshot = {
        situations: data.situations ?? [],
        fetchedAt: new Date(now).toISOString(),
        expiresAt: now + SITUATIONS_CACHE_MS,
      };
      // An old activation owns a different cache object and cannot refill
      // the current activation's snapshot after its request finishes.
      cache.snapshot = snapshot;
      return snapshot;
    } finally {
      cache.pending = undefined;
    }
  })();
  return cache.pending;
}

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

function pickLocalizedText(
  values: SituationFieldsFragment["summary"][number][] | null | undefined,
): string | undefined {
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

async function fetchGraphQl<TResult, TVariables>(
  endpoint: string,
  document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
  variables: NoInfer<TVariables>,
): Promise<TResult> {
  const payload = await fetchJson<GraphQlResponse<TResult>>(endpoint, {
    timeoutMs: 8_000,
    userAgent: null,
    headers: { "Content-Type": "application/json", "ET-Client-Name": clientName },
    errorMessage: ({ status, statusText }) =>
      `Entur GraphQL request failed: ${status} ${statusText}`,
    init: { method: "POST", body: JSON.stringify({ query: document.toString(), variables }) },
  });
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

function toLiveVehicle(vehicle: VehicleFieldsFragment | null): LiveTransitVehicle | null {
  if (
    typeof vehicle?.location?.latitude !== "number" ||
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
    positionKind: "observed",
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

function toAlert(situation: SituationFieldsFragment): ServiceAlert | null {
  if (!situation.id) return null;

  const affectedRouteIds = new Set<string>();
  const affectedStopIds = new Set<string>();

  for (const id of affectedLineIds(situation)) affectedRouteIds.add(withEnturPrefix(id));
  for (const stop of affectedStops(situation)) affectedStopIds.add(withEnturPrefix(stop.id));

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
    activePeriods: situation.validityPeriods.map((period) => ({
      start: period.startTime ?? undefined,
      end: period.endTime ?? undefined,
    })),
  };
}

function situationTouchesBbox(situation: SituationFieldsFragment, bbox: BBox): boolean {
  return affectedStops(situation).some(
    (stop) =>
      typeof stop.latitude === "number" &&
      typeof stop.longitude === "number" &&
      isInsideBbox(bbox, stop.longitude, stop.latitude),
  );
}

async function getEnturVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
  const data = await fetchGraphQl(vehiclesEndpoint, VehiclesByBoundingBoxDocument, {
    minLat: bbox[1],
    minLon: bbox[0],
    maxLat: bbox[3],
    maxLon: bbox[2],
    maxDataAge: "PT30M",
  });

  return (data.vehicles ?? [])
    .map((vehicle) => toLiveVehicle(vehicle))
    .filter((vehicle): vehicle is LiveTransitVehicle => vehicle !== null);
}

async function getEnturAlerts(bbox: BBox): Promise<{ data: ServiceAlert[]; fetchedAt: string }> {
  const snapshot = await getSituationSnapshot();
  const byId = new Map<string, ServiceAlert>();
  for (const situation of snapshot.situations) {
    if (!situationTouchesBbox(situation, bbox)) continue;
    const alert = toAlert(situation);
    if (!alert) continue;
    byId.set(alert.id, alert);
  }
  return { data: [...byId.values()], fetchedAt: snapshot.fetchedAt };
}

async function isEnturLiveTransitAvailable(): Promise<boolean> {
  try {
    await fetchGraphQl(vehiclesEndpoint, VehicleHealthCheckDocument, {});
    return true;
  } catch {
    return false;
  }
}

// Attribution metadata for the two sub-feeds (vehicles + situations) is
// declared in the manifest's dataSources; we look each up by sourceId so
// per-method calls credit only the feed that actually served them.
const attribution = createManifestAttribution();
function attributionFor(sourceId: string): Attribution[] {
  const attr = attribution.bySource(sourceId);
  return attr ? [attr] : [];
}

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => {
    situationCache = {};
    attribution.set(ctx.manifest.dataSources ?? []);
    clientName =
      ctx.config.clientName && String(ctx.config.clientName).trim().length > 0
        ? String(ctx.config.clientName).trim()
        : DEFAULT_CLIENT_NAME;
    journeyPlannerEndpoint =
      ctx.config.journeyPlannerEndpoint &&
      String(ctx.config.journeyPlannerEndpoint).trim().length > 0
        ? String(ctx.config.journeyPlannerEndpoint).trim()
        : DEFAULT_JOURNEY_PLANNER_ENDPOINT;
    vehiclesEndpoint =
      ctx.config.vehiclesEndpoint && String(ctx.config.vehiclesEndpoint).trim().length > 0
        ? String(ctx.config.vehiclesEndpoint).trim()
        : DEFAULT_VEHICLES_ENDPOINT;
  });

  ctx.registerHealthCheck(async () => {
    const available = await isEnturLiveTransitAvailable();
    return available
      ? { status: "up" as const }
      : { status: "down" as const, error: "Entur realtime vehicle probe failed" };
  });

  const provider: RealtimeProvider = {
    id: "live-transit-entur",
    coverage: { bbox: NORWAY_BBOX },
    priority: 10,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: true,
      alerts: { byStop: false, byRoute: false, byBbox: true },
      tripUpdates: false,
    },
    async getVehiclePositions(bbox: BBox) {
      const data = await getEnturVehicles(bbox);
      return withAttribution(
        captureTransitContributors(data, attributionFor("entur-live-vehicles")),
        attributionFor("entur-live-vehicles"),
        freshnessNow({ hasRealtimeData: true }),
      );
    },
    async getAlertsForBbox(bbox: BBox) {
      const snapshot = await getEnturAlerts(bbox);
      return withAttribution(
        captureTransitContributors(snapshot.data, attributionFor("entur-live-situations")),
        attributionFor("entur-live-situations"),
        {
          ...freshnessNow({ hasRealtimeData: true }),
          fetchedAt: snapshot.fetchedAt,
        },
      );
    },
  };

  ctx.registerRealtimeProvider(provider);
}
