import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "au-nsw:";
const SOURCE_ID = "au-nsw";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapAuNswPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? `Car Park ${poiId}`,
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "surface"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee, "free"),
    parkAndRide: true,
    address: asStringOrUndef(p.address),
  };
}

export function mergeAuNswLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const spots = asNumberOrUndef((live as { spots?: unknown }).spots);
  const total = asNumberOrUndef((live as { total?: unknown }).total);
  if (spots == null || total == null) return base;
  const freeSpaces = Math.max(0, spots - total);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    capacity: spots > 0 ? spots : base.capacity,
    freeSpaces,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
