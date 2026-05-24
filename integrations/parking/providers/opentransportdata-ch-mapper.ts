import { isLiveTooStale } from "@openmapx/integration-framework";
import type {
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

/**
 * Mapper + live-merger for OpenTransportData.swiss bike-and-car-parking.
 *
 * Static payload carries everything the pre-migration `featureToFacility`
 * produced except for the derived `freeSpaces`, which now arrives via the
 * live tier so apps/api can timestamp it with `realtimeDataUpdatedAt`.
 */

const STATION_ID_PREFIX = "otdch-parking:";
const SOURCE_ID = "opentransportdata-ch-parking";
const SOURCE_NAME = "OpenTransportData.swiss";
const DATASET_PAGE_URL = "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking";

const SOURCE_ATTRIBUTION: ParkingSourceAttribution = {
  contributor: SOURCE_NAME,
  license: "O-By 1.0",
  url: DATASET_PAGE_URL,
};

function asStringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asParkingType(value: unknown): ParkingType {
  if (
    value === "garage" ||
    value === "surface" ||
    value === "underground" ||
    value === "on-street" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function asFee(value: unknown): "free" | "paid" | "unknown" {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return "unknown";
}

function asAccess(value: unknown): "public" | "private" | "customers" | "permit" | undefined {
  if (value === "public" || value === "private" || value === "customers" || value === "permit") {
    return value;
  }
  return undefined;
}

function asTariffRows(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [string, string][] = [];
  for (const row of value) {
    if (
      Array.isArray(row) &&
      row.length === 2 &&
      typeof row[0] === "string" &&
      typeof row[1] === "string"
    ) {
      out.push([row[0], row[1]]);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function mapOpenTransportDataChPayload(poiId: string, payload: unknown): ParkingFacility {
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
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    fee: asFee(p.fee),
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

export function mergeOpenTransportDataChLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
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
