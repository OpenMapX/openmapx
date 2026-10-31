import type { BBox } from "@openmapx/core";
import { createEnturClient } from "@openmapx/entur-client";
import {
  captureTransitContributors,
  type IntegrationContext,
  type RealtimeProvider,
  resolveIntegrationContributors,
  snapshotContributors,
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

const NORWAY_BBOX: BBox = [4.0, 57.0, 32.0, 71.5];
const ENTUR_PREFIX = "entur:";
const VEHICLE_SOURCE_ID = "entur-live-vehicles";

interface SituationSnapshot {
  situations: SituationFieldsFragment[];
  fetchedAt: string;
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

/** Entur vehicle modes without an OpenMapX equivalent (AIR, TAXI, absent) become "other". */
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
  return "other";
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

export function setup(ctx: IntegrationContext): void {
  const { id, http, cache, upstreamRuntime } = ctx;
  const generation = new AbortController();
  const sourceIds = {
    vehicles: "entur-live-vehicles",
    journeyPlanner: "entur-live-situations",
  } as const;
  const client = createEnturClient({
    http,
    upstreamRuntime,
    config: { ...ctx.config },
    sourceIds,
    contributors: Object.fromEntries(
      Object.values(sourceIds).map((sourceId) => [
        sourceId,
        resolveIntegrationContributors(ctx, [sourceId]),
      ]),
    ),
    isSourceAllowed: async (sourceId) => {
      const denied = await ctx.getDisallowedSourceIds?.();
      return !denied?.has(sourceId) && !denied?.has(id);
    },
  });
  ctx.onShutdown(async () => {
    generation.abort(new Error("Entur live generation retired"));
  });
  const attributionFor = (sourceId: string): Attribution[] =>
    snapshotContributors(client.contributors[sourceId] ?? []);
  // The host owns the shared fill lifetime; generation retirement cancels only this waiter.
  const snapshotKey = `national-situations:v1:${client.identity}`;
  async function getSituationSnapshot(): Promise<SituationSnapshot> {
    await client.assertSourceAllowed("journeyPlanner", generation.signal);
    const snapshot = await cache.withCache(
      snapshotKey,
      15,
      async (operationSignal) => {
        const data = await client.graphQl(
          "journeyPlanner",
          NationalSituationsDocument,
          {},
          operationSignal,
        );
        return { situations: data.situations ?? [], fetchedAt: new Date().toISOString() };
      },
      generation.signal,
    );
    await client.assertSourceAllowed("journeyPlanner", generation.signal);
    return snapshot;
  }
  async function getEnturVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
    const data = await client.graphQl(
      "vehicles",
      VehiclesByBoundingBoxDocument,
      {
        minLat: bbox[1],
        minLon: bbox[0],
        maxLat: bbox[3],
        maxLon: bbox[2],
        maxDataAge: "PT30M",
      },
      generation.signal,
    );

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
      await Promise.all([
        client.graphQl("vehicles", VehicleHealthCheckDocument, {}, generation.signal),
        client.graphQl("journeyPlanner", NationalSituationsDocument, {}, generation.signal),
      ]);
      return true;
    } catch (error) {
      if (generation.signal.aborted) throw error;
      return false;
    }
  }
  ctx.registerHealthCheck(async () =>
    (await isEnturLiveTransitAvailable())
      ? { status: "up" as const }
      : { status: "down" as const, error: "Entur realtime API probe failed" },
  );
  const provider: RealtimeProvider = {
    id: "live-transit-entur",
    coverage: { bbox: NORWAY_BBOX },
    priority: 10,
    attribution: Object.values(sourceIds).flatMap(attributionFor),
    capabilities: {
      vehiclePositions: true,
      alerts: { byStop: false, byRoute: false, byBbox: true },
      tripUpdates: false,
    },
    async getVehiclePositions(bbox: BBox) {
      const data = await getEnturVehicles(bbox);
      await client.assertSourceAllowed("vehicles", generation.signal);
      return withAttribution(
        captureTransitContributors(data, attributionFor(sourceIds.vehicles)),
        attributionFor(sourceIds.vehicles),
        freshnessNow({ hasRealtimeData: true }),
      );
    },
    async getAlertsForBbox(bbox: BBox) {
      const snapshot = await getEnturAlerts(bbox);
      await client.assertSourceAllowed("journeyPlanner", generation.signal);
      return withAttribution(
        captureTransitContributors(snapshot.data, attributionFor(sourceIds.journeyPlanner)),
        attributionFor(sourceIds.journeyPlanner),
        {
          ...freshnessNow({ hasRealtimeData: true }),
          fetchedAt: snapshot.fetchedAt,
        },
      );
    },
  };
  ctx.registerRealtimeProvider(provider);
}
