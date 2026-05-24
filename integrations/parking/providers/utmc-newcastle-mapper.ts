import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

const STATION_ID_PREFIX = "utmc:";
const SOURCE_ID = "utmc-newcastle";

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

export function mapState(stateDescription?: string): "open" | "closed" | "unknown" {
  if (!stateDescription) return "unknown";
  const upper = stateDescription.toUpperCase();
  if (upper === "CLOSED" || upper === "FAULTY") return "closed";
  if (upper === "SPACES" || upper === "ALMOST FULL" || upper === "FULL" || upper === "OPEN") {
    return "open";
  }
  return "unknown";
}

export function deriveFreeSpaces(
  occupancy: number | undefined,
  capacity: number | undefined,
): number | undefined {
  if (occupancy == null || capacity == null) return undefined;
  const free = capacity - occupancy;
  return free >= 0 ? free : 0;
}

export function mapUtmcPayload(poiId: string, payload: unknown): ParkingFacility {
  // Defensive: payload shapes can drift between the parser version that wrote
  // the row and the API version reading it back.
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
    staticDataUpdatedAt: asStringOrUndef(p.staticDataUpdatedAt),
    dataUpdatedAt: asStringOrUndef(p.staticDataUpdatedAt),
    fee: asFee(p.fee),
    address: asStringOrUndef(p.address),
    state: "unknown",
  };
}

export function mergeUtmcLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const occupancy = asNumberOrUndef((live as { occupancy?: unknown }).occupancy);
  const stateDescription = asStringOrUndef(
    (live as { stateDescription?: unknown }).stateDescription,
  );
  const freeSpaces = deriveFreeSpaces(occupancy, base.capacity);
  return {
    ...base,
    freeSpaces,
    state: mapState(stateDescription),
    hasRealtimeData: true,
    realtimeDataUpdatedAt: live.asOf,
    dataUpdatedAt: live.asOf,
  };
}
