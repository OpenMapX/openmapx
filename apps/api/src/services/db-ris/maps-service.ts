/**
 * RIS::Maps service — live train GPS positions and railway geometry.
 *
 * Fetches positions for all active DB trains by administrationID,
 * merges live + emulated data, and returns normalized VehiclePositions.
 */

import { MemCache, TTL, withCacheStatus } from "../../utils/cache.js";
import type { VehiclePosition } from "../transit/types.js";
import { isRisConfigured, risPost } from "./client.js";
import type {
  RisEmulatedEntry,
  RisEmulatedResponse,
  RisJourneyPositionEntry,
  RisPositionsResponse,
  RisRailwayGeometryResponse,
} from "./maps-types.js";

// DB administration IDs: Fernverkehr (80), Regio (81), various S-Bahn operators
const DB_ADMINISTRATION_IDS = (process.env.DB_RIS_ADMINISTRATION_IDS ?? "80,81")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PROVIDER = "db-ris";

// L1 in-memory cache for positions (eliminates Redis round-trips on hot polling path)
const positionsMemCache = new MemCache<VehiclePosition[]>(4);
const POSITIONS_KEY = "ris-maps:positions";

function toVehiclePosition(entry: RisJourneyPositionEntry, _isEmulated = false): VehiclePosition {
  const transport = entry.info?.transportAtStart;
  const category = transport?.category ?? (entry as RisEmulatedEntry).category ?? "";
  const journeyName = transport?.journeyName ?? "";
  const name =
    journeyName ||
    [category, transport?.journeyNumber].filter(Boolean).join(" ") ||
    entry.journeyID;

  // Build label: "ICE 1272 · Frankfurt(Main)Hbf → Berlin Ostbahnhof"
  const origin = entry.info?.origin?.name;
  const destination = entry.info?.destination?.name;
  const route = origin && destination ? `${origin} → ${destination}` : "";
  const label = route ? `${name}\n${route}` : name;

  return {
    id: `${PROVIDER}:${entry.journeyID}`,
    provider: PROVIDER,
    tripId: `ris:${entry.journeyID}`,
    lat: entry.latitude,
    lng: entry.longitude,
    bearing: entry.direction,
    speed: entry.speed != null ? entry.speed / 3.6 : undefined, // km/h → m/s
    label,
    updatedAt: entry.meta?.timeCreated ?? new Date().toISOString(),
  };
}

export async function getTrainPositions(): Promise<VehiclePosition[]> {
  if (!isRisConfigured()) return [];

  // L1: in-memory cache check
  const memHit = positionsMemCache.get(POSITIONS_KEY);
  if (memHit && !memHit.stale) return memHit.data;

  // L2: Redis + upstream fetch
  const { data } = await withCacheStatus<VehiclePosition[]>(
    POSITIONS_KEY,
    TTL.transit.vehicles,
    async () => {
      const body = { administrationIDs: DB_ADMINISTRATION_IDS };

      const [liveResult, emulatedResult] = await Promise.allSettled([
        risPost<RisPositionsResponse>("maps", "/journey-positions/", body),
        risPost<RisEmulatedResponse>("maps", "/journey-positions/emulated", body),
      ]);

      const liveEntries: RisJourneyPositionEntry[] =
        liveResult.status === "fulfilled" ? (liveResult.value.positions ?? []) : [];
      const emulatedEntries: RisEmulatedEntry[] =
        emulatedResult.status === "fulfilled" ? (emulatedResult.value.positions ?? []) : [];

      // Merge: live GPS data takes priority over emulated
      const byJourneyId = new Map<string, VehiclePosition>();
      for (const entry of emulatedEntries) {
        byJourneyId.set(entry.journeyID, toVehiclePosition(entry, true));
      }
      for (const entry of liveEntries) {
        byJourneyId.set(entry.journeyID, toVehiclePosition(entry, false));
      }

      return [...byJourneyId.values()];
    },
    { staleOnError: true },
  );

  // Update L1 cache
  positionsMemCache.set(POSITIONS_KEY, data, 10_000, 20_000);
  return data;
}

export async function getJourneyGeometry(
  journeyIds: string[],
): Promise<RisRailwayGeometryResponse | null> {
  if (!isRisConfigured() || journeyIds.length === 0) return null;

  // Cap at 50 journey IDs per request
  const ids = journeyIds.slice(0, 50);

  try {
    return await risPost<RisRailwayGeometryResponse>("maps", "/railways/sections/by-journeyid", {
      journeyIDs: ids,
    });
  } catch {
    return null;
  }
}
