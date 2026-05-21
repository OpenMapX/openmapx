import {
  isRisConfigured,
  risPost,
  setRisCredentials,
} from "@integrations/geocoding-db-ris/ris-client.js";
import type {
  LiveTransitProvider,
  LiveTransitVehicle,
} from "@integrations/overlay-live-transit/types.js";
import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";

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
  if (!isRisConfigured()) return [];

  const body = { administrationIDs: administrationIds };
  const [liveResult, emulatedResult] = await Promise.allSettled([
    risPost<RisPositionsResponse>("maps", "/journey-positions/", body),
    risPost<RisEmulatedResponse>("maps", "/journey-positions/emulated", body),
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
  setRisCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });

  const administrationIds = parseAdministrationIds(ctx.config.administrationIds);

  const provider: LiveTransitProvider = {
    id: "live-transit-db-ris",
    priority: 20,
    coverage: { bbox: GERMANY_BBOX },
    getVehicles: (bbox: BBox) => getDbLiveTransitVehicles(bbox, administrationIds),
  };

  ctx.registerProvider("live-transit", provider);
}
