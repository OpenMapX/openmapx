import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "sg:";
const SOURCE_ID = "singapore";
// data.gov.sg publishes per-minute snapshots; 30 min covers ≥6 missed runs.
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapSingaporePayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? `Car Park ${poiId}`,
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "unknown"),
    hasRealtimeData: false,
    fee: asFee(p.fee, "unknown"),
    address: asStringOrUndef(p.address),
    maxHeight: asNumberOrUndef(p.maxHeight),
  };
}

export function mergeSingaporeLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const capacity = asNumberOrUndef((live as { capacity?: unknown }).capacity);
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  if (capacity == null) return base;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    capacity,
    freeSpaces,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
