import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

// Mobidrom-family upstream feeds publish every ~5 min; flag as not-realtime
// after 30 min so a stuck cache stops reading as live.
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

interface MobidromMapperOptions {
  sourceId: string;
  idPrefix: string;
  operatorName?: string;
}

function asStringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolOrUndef(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function asFee(value: unknown): "free" | "paid" | "unknown" | undefined {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return undefined;
}

function asState(value: unknown): "open" | "closed" | "unknown" {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return "unknown";
}

/**
 * Builds the static→ParkingFacility mapper closure for a single Mobidrom-family
 * source. `hasRealtimeData` starts false; `mergeMobidromLive` flips it on when
 * the live Redis hash carries a per-poi entry.
 */
export function makeMobidromMapper(
  opts: MobidromMapperOptions,
): (poiId: string, payload: unknown) => ParkingFacility {
  const { sourceId, idPrefix, operatorName } = opts;
  return (poiId, payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const coordinates = Array.isArray(p.coordinates)
      ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
      : ([0, 0] as [number, number]);
    return {
      id: `${idPrefix}:${poiId}`,
      name: asStringOrUndef(p.name) ?? "Parking",
      coordinates,
      sources: [sourceId],
      parkingType: asParkingType(p.parkingType),
      capacity: asNumberOrUndef(p.capacity),
      hasRealtimeData: false,
      disabledSpaces: asNumberOrUndef(p.disabledSpaces),
      chargingSpaces: asNumberOrUndef(p.chargingSpaces),
      maxHeight: asNumberOrUndef(p.maxHeight),
      fee: asFee(p.fee),
      feeDescription: asStringOrUndef(p.feeDescription),
      operator: asStringOrUndef(p.operator) ?? operatorName,
      address: asStringOrUndef(p.address),
      openingHours: asStringOrUndef(p.openingHours),
      state: asState(p.state),
      parkAndRide: asBoolOrUndef(p.parkAndRide),
      url: asStringOrUndef(p.url),
    };
  };
}

export function mergeMobidromLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  if (freeSpaces == null) return base;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
