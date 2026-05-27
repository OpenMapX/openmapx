import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import { asAccess, asFee, asParkingType, asState, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "barcelona:";
const SOURCE_ID = "barcelona-es";

export function mapBarcelonaPayload(poiId: string, payload: unknown): ParkingFacility {
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
    hasRealtimeData: false,
    fee: asFee(p.fee, "paid"),
    feeDescription: asStringOrUndef(p.feeDescription),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    state: asState(p.state, undefined),
  };
}
