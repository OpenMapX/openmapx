import type { LiveTransitVehicle } from "@integrations/overlay-live-transit/types.js";
import type { BBox } from "@openmapx/core";
import { mobilityHttpTransport } from "@openmapx/core/mobility-http-transport";
import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import { withAttribution } from "@openmapx/mobility-core/result";
import { createRisClient, type RisCredentials } from "@openmapx/mobility-core/ris-client";

const attribution = createManifestAttribution();
let risClient = createRisClient({}, mobilityHttpTransport);

export function setRisCredentials(
  credentials: RisCredentials,
  transport: MobilityHttpTransport = mobilityHttpTransport,
): void {
  risClient = createRisClient(credentials, transport);
}

interface RisTransportInfo {
  journeyName?: string;
  journeyNumber?: number;
  category?: string;
}

interface RisJourneyPositionEntry {
  journeyID: string;
  latitude: number;
  longitude: number;
  direction?: number;
  speed?: number;
  info?: {
    transportAtStart?: RisTransportInfo;
    origin?: { name?: string };
    destination?: { name?: string };
  };
  meta?: { timeCreated?: string };
}

interface RisPositionsResponse {
  positions?: RisJourneyPositionEntry[];
}

interface RisEmulatedEntry extends RisJourneyPositionEntry {
  category?: string;
}

interface RisEmulatedResponse {
  positions?: RisEmulatedEntry[];
}

const PROVIDER_ID = "db-ris-maps";
const GERMANY_BBOX: BBox = [5.87, 47.27, 15.04, 55.06];

function parseAdministrationIds(raw: unknown): string[] {
  return String(raw ?? "80,81")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isInsideBbox(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function toLiveVehicle(
  entry: RisJourneyPositionEntry,
  isEmulated = false,
): LiveTransitVehicle | null {
  if (
    !Number.isFinite(entry.latitude) ||
    !Number.isFinite(entry.longitude) ||
    entry.latitude < -90 ||
    entry.latitude > 90 ||
    entry.longitude < -180 ||
    entry.longitude > 180
  ) {
    return null;
  }

  const transport = entry.info?.transportAtStart;
  const category =
    transport?.category ?? (isEmulated ? (entry as RisEmulatedEntry).category : undefined);
  const fallbackJourneyName = [category, transport?.journeyNumber].filter(Boolean).join(" ");
  const journeyName = transport?.journeyName || fallbackJourneyName || entry.journeyID;
  const origin = entry.info?.origin?.name;
  const destination = entry.info?.destination?.name;
  const secondaryLabel = origin && destination ? `${origin} -> ${destination}` : undefined;

  return {
    id: `${PROVIDER_ID}:${entry.journeyID}`,
    provider: PROVIDER_ID,
    sourceId: PROVIDER_ID,
    mode: "rail",
    displayLabel: journeyName,
    secondaryLabel,
    tripId: `ris:${entry.journeyID}`,
    lat: entry.latitude,
    lng: entry.longitude,
    bearing: entry.direction ?? undefined,
    speed: entry.speed != null ? entry.speed / 3.6 : undefined,
    label: secondaryLabel ? `${journeyName}\n${secondaryLabel}` : journeyName,
    updatedAt: entry.meta?.timeCreated ?? new Date().toISOString(),
  };
}

async function getDbLiveTransitVehicles(
  bbox: BBox,
  administrationIds: string[],
): Promise<LiveTransitVehicle[]> {
  if (!risClient.isConfigured()) return [];

  const body = { administrationIDs: administrationIds };
  const [liveResult, emulatedResult] = await Promise.allSettled([
    risClient.post<RisPositionsResponse>("maps", "/journey-positions/", body),
    risClient.post<RisEmulatedResponse>("maps", "/journey-positions/emulated", body),
  ]);

  const liveEntries = liveResult.status === "fulfilled" ? (liveResult.value.positions ?? []) : [];
  const emulatedEntries =
    emulatedResult.status === "fulfilled" ? (emulatedResult.value.positions ?? []) : [];

  const byJourneyId = new Map<string, LiveTransitVehicle>();
  for (const entry of emulatedEntries) {
    const vehicle = toLiveVehicle(entry, true);
    if (!vehicle || !isInsideBbox(bbox, vehicle.lng, vehicle.lat)) continue;
    byJourneyId.set(entry.journeyID, vehicle);
  }
  for (const entry of liveEntries) {
    const vehicle = toLiveVehicle(entry, false);
    if (!vehicle || !isInsideBbox(bbox, vehicle.lng, vehicle.lat)) continue;
    byJourneyId.set(entry.journeyID, vehicle);
  }

  return [...byJourneyId.values()];
}

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => {
    attribution.set(ctx.manifest.dataSources ?? []);
    setRisCredentials({
      clientId: ctx.config.clientId as string | undefined,
      apiKey: ctx.config.apiKey as string | undefined,
    });
  });

  const administrationIds = parseAdministrationIds(ctx.config.administrationIds);

  const provider: RealtimeProvider = {
    id: "live-transit-db-ris",
    coverage: { bbox: GERMANY_BBOX },
    priority: 20,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      tripUpdates: false,
    },
    /**
     * Returns DB RIS Maps realtime journey positions. The runtime payload
     * elements are `LiveTransitVehicle` (a structural superset of the
     * framework's `VehiclePosition`); structural typing preserves the richer
     * integration-side fields (`sourceId`, `displayLabel`, etc.).
     */
    async getVehiclePositions(bbox: BBox) {
      const data = await getDbLiveTransitVehicles(bbox, administrationIds);
      return withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));
    },
  };

  ctx.registerRealtimeProvider(provider);
}
