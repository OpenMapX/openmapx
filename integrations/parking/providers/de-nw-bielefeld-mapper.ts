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
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "de-nw-bielefeld:";
const SOURCE_ID = "de-nw-bielefeld";
// Bielefeld's PLS feed updates every ~5 min; 30 min covers a few missed
// ticks before flipping hasRealtimeData off.
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapDeNwBielefeldPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    sourceUid: asStringOrUndef(p.sourceUid),
    parkingType: asParkingType(p.parkingType, "surface"),
    capacity: asNumberOrUndef(p.capacity),
    // True for entries with a PLS feed (major garages) — the merge step flips
    // it back off when the latest live snapshot is stale or missing.
    hasRealtimeData: p.hasPlsFeed === true,
    fee: asFee(p.fee, "unknown"),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    feeDescription: asStringOrUndef(p.feeDescription),
    maxHeight: asNumberOrUndef(p.maxHeight),
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    womenSpaces: asNumberOrUndef(p.womenSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
  };
}

export function mergeDeNwBielefeldLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) {
    // No live entry this tick — if the facility has a PLS feed declared,
    // keep hasRealtimeData=true so the UI still labels it as live-capable;
    // the next merge will overwrite with fresh data.
    return base;
  }
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const state = asState((live as { state?: unknown }).state, undefined);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    state,
    hasRealtimeData: freeSpaces != null && !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
