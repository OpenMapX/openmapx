import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

const STATION_ID_PREFIX = "madrid:";
const SOURCE_ID = "madrid-es";

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
  return "garage";
}

function asFee(value: unknown): "free" | "paid" | "unknown" {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return "paid";
}

export function mapMadridPayload(poiId: string, payload: unknown): ParkingFacility {
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
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    fee: asFee(p.fee),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
    parkAndRide: asBoolOrUndef(p.parkAndRide),
  };
}
