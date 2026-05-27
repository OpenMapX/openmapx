import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asState, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "ghent:";
const SOURCE_ID = "ghent-be";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

export function mapGhentPayload(poiId: string, payload: unknown): ParkingFacility {
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
    // Endpoint is the live source — leave hasRealtimeData=true so the API
    // surfaces freshness even when a particular record lacks availability.
    hasRealtimeData: true,
    fee: asFee(p.fee, "paid"),
    operator: asStringOrUndef(p.operator),
    openingHours: asStringOrUndef(p.openingHours),
    state: "unknown",
    url: asStringOrUndef(p.url),
  };
}

export function mergeGhentLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const state = asState((live as { state?: unknown }).state, "unknown");
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces: freeSpaces ?? base.freeSpaces,
    state,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
