import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asAccess,
  asBoolOrUndef,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringOrUndef,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "at-9-vienna:";
const SOURCE_ID = "at-9-vienna";

export function mapAt9ViennaPayload(poiId: string, payload: unknown): ParkingFacility {
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
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    fee: asFee(p.fee, "unknown"),
    access: asAccess(p.access),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
    parkAndRide: asBoolOrUndef(p.parkAndRide),
    url: asStringOrUndef(p.url),
  };
}
