import type { ParkingFacility } from "@openmapx/mobility-core/parking";

import {
  asBoolOrUndef,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asState,
  asStringOrUndef,
} from "./mapper-utils.js";

const STATION_ID_PREFIX = "db-bahnpark:";
const SOURCE_ID = "db-bahnpark";

function asTariffRows(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: [string, string][] = [];
  for (const item of value) {
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[0] === "string" &&
      typeof item[1] === "string"
    ) {
      rows.push([item[0], item[1]]);
    }
  }
  return rows.length > 0 ? rows : undefined;
}

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
