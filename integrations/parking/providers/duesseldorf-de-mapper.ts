import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

const STATION_ID_PREFIX = "duesseldorf:";
const SOURCE_ID = "duesseldorf-de";
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

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
  return "garage";
}

function asFee(value: unknown): "free" | "paid" | "unknown" {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return "paid";
}

function asAccess(value: unknown): "public" | "private" | "customers" | "permit" | undefined {
  if (value === "public" || value === "private" || value === "customers" || value === "permit") {
    return value;
  }
  return undefined;
}

function asState(value: unknown): "open" | "closed" | "unknown" | undefined {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return undefined;
}

function asTrend(value: unknown): "increasing" | "decreasing" | "constant" | undefined {
  if (value === "increasing" || value === "decreasing" || value === "constant") return value;
  return undefined;
}

export function mapDuesseldorfPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: true,
    fee: asFee(p.fee),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    maxHeight: asNumberOrUndef(p.maxHeight),
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    womenSpaces: asNumberOrUndef(p.womenSpaces),
    feeDescription: asStringOrUndef(p.feeDescription),
    url: asStringOrUndef(p.url),
  };
}

export function mergeDuesseldorfLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return { ...base, hasRealtimeData: false };
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const state = asState((live as { state?: unknown }).state);
  const trend = asTrend((live as { trend?: unknown }).trend);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    state,
    trend,
    hasRealtimeData: freeSpaces != null && !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
