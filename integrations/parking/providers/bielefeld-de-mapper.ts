import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

const STATION_ID_PREFIX = "bielefeld:";
const SOURCE_ID = "bielefeld-de";
// Bielefeld's PLS feed updates every ~5 min; 30 min covers a few missed
// ticks before flipping hasRealtimeData off.
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
  return "surface";
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

function asState(value: unknown): "open" | "closed" | "unknown" | undefined {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return undefined;
}

export function mapBielefeldPayload(poiId: string, payload: unknown): ParkingFacility {
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
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    // True for entries with a PLS feed (major garages) — the merge step flips
    // it back off when the latest live snapshot is stale or missing.
    hasRealtimeData: p.hasPlsFeed === true,
    fee: asFee(p.fee),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
    feeDescription: asStringOrUndef(p.feeDescription),
    maxHeight: asNumberOrUndef(p.maxHeight),
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    womenSpaces: asNumberOrUndef(p.womenSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
  };
}

export function mergeBielefeldLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) {
    // No live entry this tick — if the facility has a PLS feed declared,
    // keep hasRealtimeData=true so the UI still labels it as live-capable;
    // the next merge will overwrite with fresh data.
    return base;
  }
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const state = asState((live as { state?: unknown }).state);
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    state,
    hasRealtimeData: freeSpaces != null && !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
