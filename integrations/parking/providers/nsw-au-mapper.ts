import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

const STATION_ID_PREFIX = "nsw:";
const SOURCE_ID = "nsw-au";

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
  return "free";
}

export function mapNswAuPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? `Car Park ${poiId}`,
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee),
    parkAndRide: true,
    address: asStringOrUndef(p.address),
  };
}

export function mergeNswAuLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const spots = asNumberOrUndef((live as { spots?: unknown }).spots);
  const total = asNumberOrUndef((live as { total?: unknown }).total);
  if (spots == null || total == null) return base;
  const freeSpaces = Math.max(0, spots - total);
  return {
    ...base,
    capacity: spots > 0 ? spots : base.capacity,
    freeSpaces,
    hasRealtimeData: true,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
