import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

/**
 * Mapper + live-merger for NDW Netherlands truck parking.
 *
 * Static payload mirrors the pre-migration `buildFacilities` static side
 * (everything that didn't depend on the dynamic status feed). The live merger
 * applies vacantSpaces, derives `state` from `siteStatus`, and flips
 * `hasRealtimeData` to true the moment Redis carries a status entry — even
 * when vacantSpaces is null (pre-migration, `hasRealtime` was just
 * `status !== undefined`).
 */

const STATION_ID_PREFIX = "ndw-truck:";
const SOURCE_ID = "ndw-truck-nl";

function stateFromSiteStatus(siteStatus: unknown): "open" | "closed" | "unknown" {
  if (typeof siteStatus !== "string") return "unknown";
  if (siteStatus === "closed") return "closed";
  if (siteStatus.length > 0) return "open";
  return "unknown";
}

export function mapNdwTruckNlPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    parkingType: asParkingType(p.parkingType, "surface"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee, "unknown"),
    state: "unknown",
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    chargingDetails: asStringOrUndef(p.chargingDetails),
  };
}

export function mergeNdwTruckNlLive(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const rawFree = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const siteStatus = (live as { siteStatus?: unknown }).siteStatus;
  const stale = isLiveTooStale(live, MAX_LIVE_AGE_MS);

  return {
    ...base,
    freeSpaces: rawFree,
    hasRealtimeData: !stale,
    state: stateFromSiteStatus(siteStatus),
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
  };
}
