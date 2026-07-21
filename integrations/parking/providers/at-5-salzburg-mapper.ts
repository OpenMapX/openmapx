import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import {
  asAccess,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringArray,
  asStringOrUndef,
  asTrend,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "at-5-salzburg:";
const SOURCE_ID = "at-5-salzburg";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapAt5SalzburgPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "garage"),
    capacity: asNumberOrUndef(p.capacity),
    // Default off — Salzburg's feed mixes live + directory entries. The merge
    // step flips it on when a live record is present.
    hasRealtimeData: false,
    fee: asFee(p.fee, "paid"),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    feeDescription: asStringOrUndef(p.feeDescription),
    operator: asStringOrUndef(p.operator),
    sourceUrl: asStringOrUndef(p.sourceUrl),
    qualityWarnings: asStringArray(p.qualityWarnings),
    url: asStringOrUndef(p.url),
  };
}

export function mergeAt5SalzburgLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const trend = asTrend((live as { trend?: unknown }).trend);
  // Surface the live entry as long as it carries any usable signal — trend
  // alone is meaningful even when `FREIE_PLAETZE` came in as "nicht bekannt".
  if (freeSpaces == null && trend == null) return base;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    trend,
    hasRealtimeData: freeSpaces != null && !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
