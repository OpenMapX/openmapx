import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Mapper for German Autobahn parking. Static-only: there is no realtime
 * occupancy from the Autobahn API, only the `isBlocked` flag which is part
 * of the static payload.
 */

const STATION_ID_PREFIX = "autobahn:";
const SOURCE_ID = "autobahn-de";

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

function asState(value: unknown): "open" | "closed" | "unknown" {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return "open";
}

export function mapAutobahnDePayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Rastplatz",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee),
    state: asState(p.state),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    chargingDetails: asStringOrUndef(p.chargingDetails),
  };
}
