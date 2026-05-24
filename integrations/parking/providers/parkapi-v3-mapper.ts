import type {
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

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

const STATION_ID_PREFIX = "parkapi-v3:";
const REALTIME_STALE_AFTER_MS = 30 * 60 * 1000;

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

function asFee(value: unknown): "free" | "paid" | "unknown" {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return "unknown";
}

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

function isStaleTimestamp(value: string | undefined, staleAfterMs: number, now: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return now - time > staleAfterMs;
}

export function mapParkApiV3Payload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  const staticDataUpdatedAt = asStringOrUndef(p.staticDataUpdatedAt);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: ["parkapi-v3"],
    sourceUid: asStringOrUndef(p.sourceUid),
    sourceName: asStringOrUndef(p.sourceName),
    sourceUrl: asStringOrUndef(p.sourceUrl),
    sourceAttribution: asAttribution(p.sourceAttribution),
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    dataUpdatedAt: staticDataUpdatedAt,
    staticDataUpdatedAt,
    disabledSpaces: asNumberOrUndef(p.disabledSpaces),
    chargingSpaces: asNumberOrUndef(p.chargingSpaces),
    maxHeight: asNumberOrUndef(p.maxHeight),
    fee: asFee(p.fee),
    feeDescription: asStringOrUndef(p.feeDescription),
    operator: asStringOrUndef(p.operator),
    address: asStringOrUndef(p.address),
    openingHours: asStringOrUndef(p.openingHours),
    url: asStringOrUndef(p.url),
  };
}

export function mergeParkApiV3Live(
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
  // the parser, which sources it from `realtime_data_updated_at`).
  const isStale = isStaleTimestamp(live.asOf, REALTIME_STALE_AFTER_MS, Date.now());
  if (isStale) warnings.push("Realtime availability is older than 30 minutes.");

  const existingWarnings = base.qualityWarnings ?? [];
  const mergedWarnings = [...existingWarnings, ...warnings];

  return {
    ...base,
    capacity,
    freeSpaces,
    hasRealtimeData: true,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
    isStale: isStale || undefined,
    qualityWarnings: mergedWarnings.length > 0 ? mergedWarnings : undefined,
  };
}
