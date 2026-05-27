import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "utmc:";
const SOURCE_ID = "utmc-newcastle";
// UTMC has a 2-min upstream cron; flag as not-realtime after 15 minutes of
// silence (≈7.5 missed runs) so consumers stop trusting occupancy.
const MAX_LIVE_AGE_MS = 15 * 60 * 1000;

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
    parkingType: asParkingType(p.parkingType, "garage"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    staticDataUpdatedAt: asStringOrUndef(p.staticDataUpdatedAt),
    dataUpdatedAt: asStringOrUndef(p.staticDataUpdatedAt),
    fee: asFee(p.fee, "unknown"),
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
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);
  return {
    ...base,
    freeSpaces,
    state: mapState(stateDescription),
    hasRealtimeData: !stale,
    realtimeDataUpdatedAt: live.asOf,
    dataUpdatedAt: live.asOf,
  };
}
