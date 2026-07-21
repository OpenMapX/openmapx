import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility, ParkingSourceAttribution } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import {
  asAccess,
  asFee,
  asNumberOrUndef,
  asParkingType,
  asStringOrUndef,
  asTariffRows,
} from "./mapper-utils.js";

const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

/**
 * Mapper + live-merger for OpenTransportData.swiss bike-and-car-parking.
 *
 * Static payload carries everything the pre-migration `featureToFacility`
 * produced except for the derived `freeSpaces`, which now arrives via the
 * live tier so apps/api can timestamp it with `realtimeDataUpdatedAt`.
 */

const STATION_ID_PREFIX = "ch-otd:";
const SOURCE_ID = "ch-otd";
const SOURCE_NAME = "OpenTransportData.swiss";
const DATASET_PAGE_URL = "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking";

const SOURCE_ATTRIBUTION: ParkingSourceAttribution = {
  contributor: SOURCE_NAME,
  license: "O-By 1.0",
  url: DATASET_PAGE_URL,
};

export function mapChOtdPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);
  // Pre-migration always emitted a boolean (`type === "PARK_AND_RAIL"` → false
  // for non-rail entries). Preserve that so downstream UI keeps the field
  // shape stable.
  const parkAndRide = p.parkAndRide === true;

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    sourceName: SOURCE_NAME,
    sourceUrl: DATASET_PAGE_URL,
    sourceAttribution: SOURCE_ATTRIBUTION,
    parkingType: asParkingType(p.parkingType, "unknown"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    fee: asFee(p.fee, "unknown"),
    feeDescription: asStringOrUndef(p.feeDescription),
    tariffRows: asTariffRows(p.tariffRows),
    access: asAccess(p.access),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    state: "open",
    parkAndRide,
    paymentMethods: asStringOrUndef(p.paymentMethods),
    url: asStringOrUndef(p.url),
  };
}

export function mergeChOtdLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const rawFree = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  if (rawFree === undefined) return base;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces: rawFree,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
