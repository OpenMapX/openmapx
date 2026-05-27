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

const STATION_ID_PREFIX = "trier:";
const SOURCE_ID = "trier-de";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapTrierPayload(poiId: string, payload: unknown): ParkingFacility {
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
    operator: asStringOrUndef(p.operator),
    openingHours: asStringOrUndef(p.openingHours),
  };
}

export function mergeTrierLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return { ...base, hasRealtimeData: false };
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
