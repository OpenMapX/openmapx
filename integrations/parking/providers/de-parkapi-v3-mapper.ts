import { isLiveTooStale } from "@openmapx/integration-framework";
import type { ParkingFacility, ParkingSourceAttribution } from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

import { asFee, asNumberOrUndef, asParkingType, asStringOrUndef } from "./mapper-utils.js";

/**
 * Mapper + live-merger for ParkAPI v3 (MobiData BW).
 *
 * Static payload carries everything the pre-migration `siteToFacility` produced
 * for the non-realtime path: identity, location, type, capacity, attribution,
 * fee/operator/address/opening-hours. The live merger applies realtime free
 * spaces, clamps and warnings, and stamps `realtimeDataUpdatedAt` from
 * `live.asOf` — exactly the fields the previous in-memory pipeline derived
 * from `has_realtime_data` + `realtime_free_capacity`.
 */

const STATION_ID_PREFIX = "de-parkapi-v3:";
const REALTIME_STALE_AFTER_MS = 30 * 60 * 1000;

function asAttribution(value: unknown): ParkingSourceAttribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const out: ParkingSourceAttribution = {
    name: asStringOrUndef(a.name),
    url: asStringOrUndef(a.url),
    contributor: asStringOrUndef(a.contributor),
    license: asStringOrUndef(a.license),
    licenseUrl: asStringOrUndef(a.licenseUrl),
  };
  // Drop the object entirely if every field is empty so we don't leak {} blobs.
  if (
    out.name === undefined &&
    out.url === undefined &&
    out.contributor === undefined &&
    out.license === undefined &&
    out.licenseUrl === undefined
  ) {
    return undefined;
  }
  return out;
}

export function mapDeParkapiV3Payload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  const staticDataUpdatedAt = asStringOrUndef(p.staticDataUpdatedAt);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: ["de-parkapi-v3"],
    sourceUid: asStringOrUndef(p.sourceUid),
    sourceName: asStringOrUndef(p.sourceName),
    sourceUrl: asStringOrUndef(p.sourceUrl),
    sourceAttribution: asAttribution(p.sourceAttribution),
    parkingType: asParkingType(p.parkingType, "unknown"),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    dataUpdatedAt: staticDataUpdatedAt,
    staticDataUpdatedAt,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee, "unknown"),
    feeDescription: asStringOrUndef(p.feeDescription),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
  };
}

export function mergeDeParkapiV3Live(
  base: ParkingFacility,
  live: PoiLiveState | null,
): ParkingFacility {
  if (!live) return base;
  const rawFree = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const liveCapacity = asNumberOrUndef((live as { capacity?: unknown }).capacity);
  const capacity = base.capacity ?? liveCapacity;

  if (rawFree === undefined) return base;

  let freeSpaces = rawFree;
  const warnings: string[] = [];
  if (freeSpaces < 0) {
    warnings.push("Realtime free-space count was negative and was clamped to 0.");
    freeSpaces = 0;
  }
  if (capacity !== undefined && freeSpaces > capacity) {
    warnings.push("Realtime free-space count exceeded capacity and was clamped.");
    freeSpaces = capacity;
  }

  // Pre-migration code surfaced staleness against now(); the live `asOf` is
  // the freshest signal we have post-migration (data-manager writes it from
  // the parser, which sources it from `realtime_data_updated_at`). Use the
  // shared `isLiveTooStale` helper so the realtime flag flip is consistent
  // with the rest of the parking mappers.
  const stale = isLiveTooStale(live, REALTIME_STALE_AFTER_MS);
  if (stale) warnings.push("Realtime availability is older than 30 minutes.");

  const existingWarnings = base.qualityWarnings ?? [];
  const mergedWarnings = [...existingWarnings, ...warnings];

  return {
    ...base,
    capacity,
    freeSpaces,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
    isStale: stale || undefined,
    qualityWarnings: mergedWarnings.length > 0 ? mergedWarnings : undefined,
  };
}
