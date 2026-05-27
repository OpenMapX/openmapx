import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asAccess,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringOrUndef,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "bremen:";
const SOURCE_ID = "bremen-de";

export function mapBremenPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    sourceUid: asStringOrUndef(p.sourceUid),
    parkingType: asParkingType(p.parkingType, "garage"),
    hasRealtimeData: false,
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee, "paid"),
    access: asAccess(p.access),
    url: asStringOrUndef(p.url),
  };
}
