import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asBoolOrUndef,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asState,
  asStringOrUndef,
  asTariffRows,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "db-bahnpark:";
const SOURCE_ID = "db-bahnpark";

export function mapDbBahnParkPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? `Parking ${poiId}`,
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "unknown"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee, "unknown"),
    tariffRows: asTariffRows(p.tariffRows),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    parkAndRide: asBoolOrUndef(p.parkAndRide),
    nearestStation: asStringOrUndef(p.nearestStation),
    chargingDetails: asStringOrUndef(p.chargingDetails),
    paymentMethods: asStringOrUndef(p.paymentMethods),
    url: asStringOrUndef(p.url),
    state: asState(p.state, "unknown"),
  };
}
