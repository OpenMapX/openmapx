import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asAccess,
  asBoolOrUndef,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringOrUndef,
  asTariffRows,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "bnls:";
const SOURCE_ID = "bnls-fr";

export function mapBnlsPayload(poiId: string, payload: unknown): ParkingFacility {
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
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee, "unknown"),
    feeDescription: asStringOrUndef(p.feeDescription),
    tariffRows: asTariffRows(p.tariffRows),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    parkAndRide: asBoolOrUndef(p.parkAndRide),
    url: asStringOrUndef(p.url),
  };
}
