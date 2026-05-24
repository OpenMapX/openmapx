import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

/**
 * Mapper + live-merger for ParkAPI v2 (ParkenDD federation).
 *
 * The bundled parser fans out across per-city endpoints and emits one poiId
 * per lot, keyed as `<cityName>/<lotId>` so the external `parkapi-v2:` prefix
 * resolves back to the source by name. The static payload carries the lot
 * shape that doesn't move; the live merger overlays per-lot `freeSpaces` and
 * `state` snapshots from Redis.
 */

const STATION_ID_PREFIX = "parkapi-v2:";

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

function asState(value: unknown): "open" | "closed" | "unknown" {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return "unknown";
}

export function mapParkApiV2Payload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);
  // The per-city source label (`parkapi-v2/<cityName>`) is stored on the
  // payload so dedup/source-priority logic that expected the pre-migration
  // `sources` array keeps the city qualifier.
  const sourceLabel = asStringOrUndef(p.source) ?? "parkapi-v2";
  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [sourceLabel],
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    state: asState(p.state),
    address: asStringOrUndef(p.address),
  };
}

export function mergeParkApiV2Live(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const stateOverride = (live as { state?: unknown }).state;
  const next: ParkingFacility = { ...base };
  if (freeSpaces !== undefined) {
    next.freeSpaces = freeSpaces;
    next.hasRealtimeData = true;
    next.dataUpdatedAt = live.asOf;
    next.realtimeDataUpdatedAt = live.asOf;
  }
  if (stateOverride !== undefined) {
    next.state = asState(stateOverride);
  }
  return next;
}
