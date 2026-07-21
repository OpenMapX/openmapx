import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import {
  asAccess,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asState,
  asStringOrUndef,
  asTrend,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "de-nw-duesseldorf:";
const SOURCE_ID = "de-nw-duesseldorf";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapDeNwDuesseldorfPayload(poiId: string, payload: unknown): ParkingFacility {
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
    hasRealtimeData: true,
    fee: asFee(p.fee, "paid"),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    maxHeight: asNumberOrUndef(p.maxHeight),
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    womenSpaces: asNumberOrUndef(p.womenSpaces),
    feeDescription: asStringOrUndef(p.feeDescription),
    url: asStringOrUndef(p.url),
  };
}

export function mergeDeNwDuesseldorfLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return { ...base, hasRealtimeData: false };
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const state = asState((live as { state?: unknown }).state, undefined);
  const trend = asTrend((live as { trend?: unknown }).trend);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    state,
    trend,
    hasRealtimeData: freeSpaces != null && !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
