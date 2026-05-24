import type { DatexParkingRecord, DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for CITA Luxembourg DATEX II parking feeds.
 *
 * CITA exposes parking metadata and dynamic occupancy as TWO sibling URLs:
 *   - parking_static.xml  (DATEX II parking table — table of records)
 *   - parking_dynamic.xml (DATEX II parking status — vacant spaces by record id)
 *
 * The data-manager fetch is wired to the static table; the status feed is
 * fetched inside this parser via `globalThis.fetch`. WHY this is OK:
 *   - the same "fan-out from one fetch entry" pattern is already used by
 *     parkapi-v2-bundled-parser.ts and parkapi-v3-bundled-parser.ts;
 *   - the status XML is small (~5 records) and the call is amortised across
 *     the 5-minute cron;
 *   - if the dynamic feed errors out we still produce static rows, just
 *     without live freeSpaces.
 *
 * Record IDs are stored URL-encoded so the framework's prefix-only `poiId`
 * format (e.g. `cita-lu:P%2F1`) round-trips back to the original DATEX id
 * (`P/1`) via the mapper's `decodeURIComponent`.
 */

const STATUS_URL = "https://www.cita.lu/info_trafic/datex/parking_dynamic.xml";
const STATUS_TIMEOUT_MS = 10_000;

async function fetchStatus(log: PoiSourceLogger): Promise<DatexParkingStatus[]> {
  try {
    const res = await globalThis.fetch(STATUS_URL, {
      headers: { Accept: "application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("cita-lu: status feed returned non-2xx", { status: res.status });
      return [];
    }
    const text = await res.text();
    return parseDatexParkingStatus(text);
  } catch (err) {
    log.warn("cita-lu: status feed failed", { error: (err as Error).message });
    return [];
  }
}

export const parseCitaLuBundled: PoiBundledParseFn = async (buffer, { log }) => {
  const tableXml = buffer.toString("utf-8");
  let records: DatexParkingRecord[];
  try {
    records = parseDatexParkingTable(tableXml);
  } catch (err) {
    log.warn("cita-lu: failed to parse parking table", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const statuses = await fetchStatus(log);
  const statusById = new Map<string, DatexParkingStatus>(statuses.map((s) => [s.recordId, s]));

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const record of records) {
    const lat = record.latitude;
    const lng = record.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const encodedId = encodeURIComponent(record.id);

    // Capacity is derived from either the static totalSpaces or vacant+occupied
    // in the live status — mirrors the pre-migration `deriveCapacity` behaviour
    // so the mapper sees the same number it used to compute.
    const status = statusById.get(record.id);
    const capacity =
      record.totalSpaces ??
      (status?.vacantSpaces !== undefined && status?.occupiedSpaces !== undefined
        ? status.vacantSpaces + status.occupiedSpaces
        : undefined);

    staticRows.push({
      poiId: encodedId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.name,
        sourceUid: record.id,
        parkingType: "surface",
        capacity,
        fee:
          record.freeOfCharge === true
            ? "free"
            : record.freeOfCharge === false
              ? "paid"
              : "unknown",
      },
    });

    if (status?.vacantSpaces !== undefined) {
      live.set(encodedId, {
        asOf: status.originTime ?? new Date().toISOString(),
        freeSpaces: status.vacantSpaces,
        capacity: capacity ?? null,
        siteStatus: status.siteStatus ?? null,
      });
    }
  }

  return { static: staticRows, live };
};
