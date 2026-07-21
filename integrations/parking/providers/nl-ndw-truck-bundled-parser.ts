import type { DatexParkingRecord, DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for NDW Netherlands truck parking DATEX II feeds.
 *
 * Two sibling XML endpoints:
 *   - Truckparking_Parking_Table.xml  (static catalog — ~7 truck parking sites)
 *   - Truckparking_Parking_Status.xml (real-time vacant/occupied counts)
 *
 * The data-manager fetch points at the static table; the status XML is
 * fetched inside this parser via `globalThis.fetch`. Same WHY as
 * `cita-lu-bundled-parser.ts` and `parkapi-v3-bundled-parser.ts`: keeping
 * one PoiSource entry per logical feed is cleaner than splitting into
 * two coordinated cron jobs that share state.
 */

const STATUS_URL = "https://opendata.ndw.nu/Truckparking_Parking_Status.xml";
const STATUS_TIMEOUT_MS = 15_000;

async function fetchStatus(log: PoiSourceLogger): Promise<DatexParkingStatus[]> {
  try {
    const res = await globalThis.fetch(STATUS_URL, {
      headers: {
        "Accept-Encoding": "gzip",
        Accept: "application/xml,text/xml,*/*",
      },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("ndw-truck-nl: status feed returned non-2xx", { status: res.status });
      return [];
    }
    const text = await res.text();
    return parseDatexParkingStatus(text);
  } catch (err) {
    log.warn("ndw-truck-nl: status feed failed", { error: (err as Error).message });
    return [];
  }
}

export const parseNlNdwTruckBundled: PoiBundledParseFn = async (buffer, { log }) => {
  const tableXml = buffer.toString("utf-8");
  let records: DatexParkingRecord[];
  try {
    records = parseDatexParkingTable(tableXml);
  } catch (err) {
    log.warn("ndw-truck-nl: failed to parse parking table", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const statuses = await fetchStatus(log);
  const statusById = new Map<string, DatexParkingStatus>(statuses.map((s) => [s.recordId, s]));

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const rec of records) {
    if (!Number.isFinite(rec.latitude) || !Number.isFinite(rec.longitude)) continue;
    const poiId = rec.id;

    const hasCharging = rec.equipmentTypes?.includes("electricChargingStation") ?? false;

    staticRows.push({
      poiId,
      lng: rec.longitude,
      lat: rec.latitude,
      payload: {
        coordinates: [rec.longitude, rec.latitude] as [number, number],
        name: rec.name,
        parkingType: "surface",
        capacity: rec.totalSpaces,
        fee: rec.freeOfCharge === true ? "free" : rec.freeOfCharge === false ? "paid" : "unknown",
        chargingSpaces: hasCharging ? 1 : undefined,
        chargingDetails: hasCharging ? "EV Charging Available" : undefined,
      },
    });

    const status = statusById.get(rec.id);
    if (status) {
      live.set(poiId, {
        asOf: status.originTime ?? new Date().toISOString(),
        freeSpaces: status.vacantSpaces ?? null,
        siteStatus: status.siteStatus ?? null,
      });
    }
  }

  return { static: staticRows, live };
};
