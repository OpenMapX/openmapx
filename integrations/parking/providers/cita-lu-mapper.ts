import { isLiveTooStale } from "@openmapx/integration-framework";
import type {
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

/**
 * Mapper + live-merger for CITA Luxembourg DATEX parking.
 *
 * The static payload carries everything the pre-migration `recordToFacility`
 * derived from the DATEX table; the live merger overlays vacantSpaces and the
 * staleness/clamp warnings the in-memory provider used to compute on every
 * read. `dataUpdatedAt` mirrors `live.asOf` (DATEX `parkingStatusOriginTime`)
 * so the API surface keeps the same provenance field it used to.
 */

const STATION_ID_PREFIX = "cita-lu:";
const SOURCE_ID = "cita-lu";
const SOURCE_NAME = "CITA Luxembourg";
const SOURCE_URL = "https://www.cita.lu/";
const REALTIME_STALE_AFTER_MS = 30 * 60 * 1000;

const SOURCE_ATTRIBUTION: ParkingSourceAttribution = {
  name: SOURCE_NAME,
  url: SOURCE_URL,
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};

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
  return "unknown";
}

function statusToState(siteStatus: string | null | undefined): ParkingFacility["state"] {
  const normalized = typeof siteStatus === "string" ? siteStatus.toLowerCase() : undefined;
  if (!normalized) return "unknown";
  if (normalized.includes("closed")) return "closed";
  if (
    normalized.includes("open") ||
    normalized.includes("available") ||
    normalized.includes("full")
  ) {
    return "open";
  }
  return "unknown";
}

function decodePoiId(poiId: string): string {
  try {
    return decodeURIComponent(poiId);
  } catch {
    return poiId;
  }
}

export function mapCitaLuPayload(poiId: string, payload: unknown): ParkingFacility {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);
  const sourceUid = asStringOrUndef(p.sourceUid) ?? decodePoiId(poiId);

  return {
    id: `${STATION_ID_PREFIX}${poiId}`,
    name: asStringOrUndef(p.name) ?? "Parking",
    coordinates,
    sources: [SOURCE_ID],
    sourceUid,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    sourceAttribution: SOURCE_ATTRIBUTION,
    parkingType: asParkingType(p.parkingType),
    capacity: asNumberOrUndef(p.capacity),
    hasRealtimeData: false,
    fee: asFee(p.fee),
    state: "unknown",
  };
}

export function mergeCitaLuLive(base: ParkingFacility, live: PoiLiveState | null): ParkingFacility {
  if (!live) return base;
  const rawFree = asNumberOrUndef((live as { freeSpaces?: unknown }).freeSpaces);
  const liveCapacity = asNumberOrUndef((live as { capacity?: unknown }).capacity);
  const siteStatus = (live as { siteStatus?: unknown }).siteStatus as string | null | undefined;
  const capacity = base.capacity ?? liveCapacity;

  const state = statusToState(siteStatus);
  const next: ParkingFacility = { ...base };
  next.state = state;

  if (rawFree === undefined) return next;

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

  const stale = isLiveTooStale(live, REALTIME_STALE_AFTER_MS);
  if (stale) warnings.push("Realtime availability is older than 30 minutes.");

  return {
    ...next,
    capacity,
    freeSpaces,
    hasRealtimeData: !stale,
    dataUpdatedAt: live.asOf,
    realtimeDataUpdatedAt: live.asOf,
    isStale: stale || undefined,
    qualityWarnings: warnings.length > 0 ? warnings : undefined,
  };
}
