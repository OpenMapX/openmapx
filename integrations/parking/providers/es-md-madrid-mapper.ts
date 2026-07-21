import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asBoolOrUndef,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringOrUndef,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "es-md-madrid:";
const SOURCE_ID = "es-md-madrid";

export function mapEsMdMadridPayload(poiId: string, payload: unknown): ParkingFacility {
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
    fee: asFee(p.fee, "paid"),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
    parkAndRide: asBoolOrUndef(p.parkAndRide),
  };
}
