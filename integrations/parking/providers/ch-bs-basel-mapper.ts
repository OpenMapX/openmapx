import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const STATION_ID_PREFIX = "ch-bs-basel:";
const SOURCE_ID = "ch-bs-basel";
// Basel's upstream publishes one snapshot per hour (see the dataset's
// `published` field). A 30-minute staleness window would hide realtime
// roughly half of every hour even when the feed is healthy; 90 minutes
// gives a 30-minute grace beyond the upstream cadence.
const MAX_LIVE_AGE_MS = 90 * 60 * 1000;

export function mapChBsBaselPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "garage"),
    capacity: asNumberOrUndef(p.capacity),
    // The pre-migration impl flagged every record as hasRealtimeData=true even
    // when `free` was missing, because the feed itself is a live endpoint.
    // mergeChBsBaselLive sets dataUpdatedAt when an actual freeSpaces shows up.
    hasRealtimeData: true,
    fee: asFee(p.fee, "paid"),
    address: asStringOrUndef(p.address),
    url: asStringOrUndef(p.url),
  };
}

export function mergeChBsBaselLive(
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
