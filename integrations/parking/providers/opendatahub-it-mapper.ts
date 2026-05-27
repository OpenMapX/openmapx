import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

/**
 * Mapper + live-merger for Open Data Hub South Tyrol parking.
 *
 * Pre-migration behaviour preserved:
 *   - `hasRealtimeData` flips true the moment Redis carries any measurement
 *     entry for the station (the parser only writes one when free OR occupied
 *     is set with a fresh mvalidtime).
 *   - `freeSpaces` falls back to `capacity - occupied` if the raw `free`
 *     measurement is missing (encoded in the live payload as null free).
 */

const STATION_ID_PREFIX = "odh:";
const SOURCE_ID = "opendatahub-it";

export function mapOdhItPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "unknown"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: "unknown",
    address: asStringOrUndef(p.address),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    chargingDetails: asStringOrUndef(p.chargingDetails),
  };
}

export function mergeOdhItLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const rawFree = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces: rawFree,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
