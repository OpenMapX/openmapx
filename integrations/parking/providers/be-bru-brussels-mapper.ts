import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "be-bru-brussels:";
const SOURCE_ID = "be-bru-brussels";

export function mapBeBruBrusselsPayload(poiId: string, payload: unknown): ParkingFacility {
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
    hasRealtimeData: false,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee, "unknown"),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
  };
}
