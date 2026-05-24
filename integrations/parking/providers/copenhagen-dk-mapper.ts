import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

const STATION_ID_PREFIX = "copenhagen:";
const SOURCE_ID = "copenhagen-dk";

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
  return "unknown";
}

function asAccess(value: unknown): "public" | "private" | "customers" | "permit" | undefined {
  if (value === "public" || value === "private" || value === "customers" || value === "permit") {
    return value;
  }
  return undefined;
}

export function mapCopenhagenPayload(poiId: string, payload: unknown): ParkingFacility {
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
    hasRealtimeData: false,
    fee: asFee(p.fee),
    access: asAccess(p.access),
    address: asStringOrUndef(p.address),
  };
}
