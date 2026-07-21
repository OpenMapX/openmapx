import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import { asFee, asNumberOrUndef, asParkingType, asState, asStringOrUndef } from "./mapper-utils.js";

/**
 * Mapper for German Autobahn parking. Static-only: there is no realtime
 * occupancy from the Autobahn API, only the `isBlocked` flag which is part
 * of the static payload.
 */

const STATION_ID_PREFIX = "de-autobahn:";
const SOURCE_ID = "de-autobahn";

export function mapDeAutobahnPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Rastplatz",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "surface"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee, "free"),
    state: asState(p.state, "open"),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    chargingDetails: asStringOrUndef(p.chargingDetails),
  };
}
