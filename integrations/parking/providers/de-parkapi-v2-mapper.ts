import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asNumberOrUndef, asParkingType, asState, asStringOrUndef } from "./mapper-utils.js";

const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

/**
 * Mapper + live-merger for ParkAPI v2 (ParkenDD federation).
 *
 * The bundled parser fans out across per-city endpoints and emits one poiId
 * per lot, keyed as `<cityName>/<lotId>` so the external `de-parkapi-v2:`
 * prefix resolves back to the source by name. The static payload carries the lot
 * shape that doesn't move; the live merger overlays per-lot `freeSpaces` and
 * `state` snapshots from Redis.
 */

const STATION_ID_PREFIX = "de-parkapi-v2:";

export function mapDeParkapiV2Payload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);
  // The per-city source label (`de-parkapi-v2/<cityName>`) is stored on the
  // payload so dedup/source-priority logic that expected the pre-migration
  // `sources` array keeps the city qualifier.
  const sourceLabel = asStringOrUndef(p.source) ?? "de-parkapi-v2";
  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [sourceLabel],
    parkingType: asParkingType(p.parkingType, "unknown"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    state: asState(p.state, "unknown"),
    address: asStringOrUndef(p.address),
  };
}

export function mergeDeParkapiV2Live(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const freeSpaces = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const stateOverride = (live as { state?: unknown }).state;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  const next: ParkingFacility = { ...base };
  if (freeSpaces !== undefined) {
    next.freeSpaces = freeSpaces;
    next.hasRealtimeData = !stale;
    next.dataUpdatedAt = live.asOf;
    next.realtimeDataUpdatedAt = live.asOf;
  }
  if (stateOverride !== undefined) {
    next.state = asState(stateOverride, "unknown");
  }
  return next;
}
