import type { BoundingBox } from "@openmapx/core";
import type {
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type { DatexParkingRecord, DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";

interface DatexParkingProviderConfig {
  sourceId: string;
  sourceName: string;
  sourceUrl?: string;
  tableUrl: string;
  statusUrl?: string;
  coverage: BoundingBox;
  parkingType?: ParkingType;
  staleAfterMs?: number;
  attribution?: ParkingSourceAttribution;
}

interface DatexParkingProvider {
  search(bbox: BoundingBox): Promise<ParkingFacility[]>;
  fetchDetail(id: string): Promise<ParkingFacility | null>;
}

const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

function overlapsCoverage(a: BoundingBox, b: BoundingBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function statusByRecordId(statuses: DatexParkingStatus[]): Map<string, DatexParkingStatus> {
  return new Map(statuses.map((status) => [status.recordId, status]));
}

function isStaleTimestamp(value: string | undefined, staleAfterMs: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > staleAfterMs;
}

function statusToState(status: DatexParkingStatus | undefined): ParkingFacility["state"] {
  const normalized = status?.siteStatus?.toLowerCase();
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

function facilityId(sourceId: string, recordId: string): string {
  return `${sourceId}:${encodeURIComponent(recordId)}`;
}

function decodeFacilityId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function deriveCapacity(
  record: DatexParkingRecord,
  status: DatexParkingStatus | undefined,
): number | undefined {
  if (record.totalSpaces !== undefined) return record.totalSpaces;
  if (status?.vacantSpaces !== undefined && status.occupiedSpaces !== undefined) {
    return status.vacantSpaces + status.occupiedSpaces;
  }
  return undefined;
}

function deriveFreeSpaces(
  capacity: number | undefined,
  status: DatexParkingStatus | undefined,
  warnings: string[],
): number | undefined {
  if (status?.vacantSpaces === undefined) return undefined;
  let freeSpaces = status.vacantSpaces;
  if (freeSpaces < 0) {
    warnings.push("Realtime free-space count was negative and was clamped to 0.");
    freeSpaces = 0;
  }
  if (capacity !== undefined && freeSpaces > capacity) {
    warnings.push("Realtime free-space count exceeded capacity and was clamped.");
    freeSpaces = capacity;
  }
  return freeSpaces;
}

function recordToFacility(
  record: DatexParkingRecord,
  status: DatexParkingStatus | undefined,
  config: DatexParkingProviderConfig,
): ParkingFacility {
  const staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const warnings: string[] = [];
  const capacity = deriveCapacity(record, status);
  const freeSpaces = deriveFreeSpaces(capacity, status, warnings);
  const isStale = isStaleTimestamp(status?.originTime, staleAfterMs);
  if (isStale) warnings.push("Realtime availability is older than 30 minutes.");

  return {
    id: facilityId(config.sourceId, record.id),
    name: record.name,
    coordinates: [record.longitude, record.latitude],
    sources: [config.sourceId],
    sourceUid: record.id,
    sourceName: config.sourceName,
    sourceUrl: config.sourceUrl,
    sourceAttribution: config.attribution,
    parkingType: config.parkingType ?? "surface",
    capacity,
    freeSpaces,
    hasRealtimeData: freeSpaces !== undefined,
    dataUpdatedAt: status?.originTime,
    realtimeDataUpdatedAt: status?.originTime,
    isStale: isStale || undefined,
    qualityWarnings: warnings.length > 0 ? warnings : undefined,
    fee: record.freeOfCharge === true ? "free" : record.freeOfCharge === false ? "paid" : "unknown",
    state: statusToState(status),
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DATEX parking feed failed: ${res.status}`);
  return res.text();
}

export function createDatexParkingProvider(
  config: DatexParkingProviderConfig,
): DatexParkingProvider {
  let cache: { expiresAt: number; facilities: ParkingFacility[] } | null = null;

  async function fetchAllFacilities(): Promise<ParkingFacility[]> {
    if (cache && cache.expiresAt > Date.now()) return cache.facilities;

    const [tableXml, statusResult] = await Promise.all([
      fetchText(config.tableUrl),
      config.statusUrl
        ? fetchText(config.statusUrl).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason) => ({ status: "rejected" as const, reason }),
          )
        : Promise.resolve({ status: "fulfilled" as const, value: undefined }),
    ]);

    const records = parseDatexParkingTable(tableXml);
    const statuses =
      statusResult.status === "fulfilled" && statusResult.value
        ? parseDatexParkingStatus(statusResult.value)
        : [];
    const statusesById = statusByRecordId(statuses);
    const facilities = records.map((record) =>
      recordToFacility(record, statusesById.get(record.id), config),
    );

    cache = { expiresAt: Date.now() + CACHE_TTL_MS, facilities };
    return facilities;
  }

  async function search(bbox: BoundingBox): Promise<ParkingFacility[]> {
    if (!overlapsCoverage(bbox, config.coverage)) return [];
    const facilities = await fetchAllFacilities();
    return facilities.filter((facility) => {
      const [lng, lat] = facility.coordinates;
      return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
    });
  }

  async function fetchDetail(id: string): Promise<ParkingFacility | null> {
    const decodedId = decodeFacilityId(id);
    const facilities = await fetchAllFacilities();
    return facilities.find((facility) => facility.sourceUid === decodedId) ?? null;
  }

  return { fetchDetail, search };
}
