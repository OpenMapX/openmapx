import type {
  OdhParkingMeasurement,
  OdhParkingStation,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for Open Data Hub South Tyrol parking.
 *
 * Two sibling REST endpoints:
 *   - /v2/flat/ParkingStation         (station catalog with capacity + metadata)
 *   - /v2/flat/ParkingStation/* /latest (latest occupied/free measurements)
 *
 * The data-manager fetch points at the stations endpoint; the measurements
 * fetch happens inside this parser via `globalThis.fetch`. Same WHY as
 * `ndw-truck-nl-bundled-parser.ts` / `parkapi-v3-bundled-parser.ts`: keeping
 * one PoiSource per logical feed avoids racing two cron jobs that must agree
 * on the same station list.
 *
 * Measurements older than MEASUREMENT_MAX_AGE_MS are dropped at parse time so
 * a stuck downstream doesn't accidentally publish hour-old "live" data via
 * the Redis hash.
 */

const STATIONS_BASE = "https://mobility.api.opendatahub.com/v2/flat/ParkingStation";
const MEASUREMENTS_URL = `${STATIONS_BASE}/*/latest?select=scode,tname,mvalue,mvalidtime&where=sactive.eq.true&limit=500&shownull=false&distinct=true`;
const MEASUREMENTS_TIMEOUT_MS = 15_000;
const MEASUREMENT_MAX_AGE_MS = 60 * 60 * 1000;

function deriveLayout(station: OdhParkingStation): ParkingType {
  const layout = station.smetadata?.netex_parking?.layout;
  if (layout === "underground") return "underground";
  if (layout === "openSpace") return "surface";
  if (layout === "multiStorey" || layout === "multistorey") return "garage";
  return "unknown";
}

function getStationName(station: OdhParkingStation): string {
  const meta = station.smetadata as Record<string, unknown>;
  return (
    (meta?.name_en as string) ??
    (meta?.name_EN as string) ??
    (meta?.name_de as string) ??
    (meta?.name_DE as string) ??
    (meta?.name_it as string) ??
    (meta?.name_IT as string) ??
    (meta?.standard_name as string) ??
    station.sname
  );
}

async function fetchMeasurements(log: PoiSourceLogger): Promise<OdhParkingMeasurement[]> {
  try {
    const res = await globalThis.fetch(MEASUREMENTS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MEASUREMENTS_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("opendatahub-it: measurements feed returned non-2xx", { status: res.status });
      return [];
    }
    const data = (await res.json()) as { data?: OdhParkingMeasurement[] };
    return data.data ?? [];
  } catch (err) {
    log.warn("opendatahub-it: measurements feed failed", { error: (err as Error).message });
    return [];
  }
}

export const parseIt32OpendatahubBundled: PoiBundledParseFn = async (buffer, { log }) => {
  let stations: OdhParkingStation[];
  try {
    const parsed = JSON.parse(buffer.toString("utf-8")) as { data?: OdhParkingStation[] };
    stations = parsed.data ?? [];
  } catch (err) {
    log.warn("opendatahub-it: failed to parse stations JSON", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const measurements = await fetchMeasurements(log);
  const measMap = new Map<string, { occupied?: number; free?: number; asOf: string }>();
  const now = Date.now();
  for (const m of measurements) {
    if (m.tname !== "occupied" && m.tname !== "free") continue;
    const validTime = new Date(m.mvalidtime);
    if (now - validTime.getTime() > MEASUREMENT_MAX_AGE_MS) continue;
    const existing = measMap.get(m.scode) ?? { asOf: m.mvalidtime };
    if (m.tname === "occupied") existing.occupied = m.mvalue;
    if (m.tname === "free") existing.free = m.mvalue;
    // Keep the freshest mvalidtime across {occupied, free} for the same station.
    if (Date.parse(m.mvalidtime) > Date.parse(existing.asOf)) existing.asOf = m.mvalidtime;
    measMap.set(m.scode, existing);
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const station of stations) {
    const lng = station.scoordinate?.x;
    const lat = station.scoordinate?.y;
    if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) continue;
    if (!station.scode) continue;

    const capacity = station.smetadata?.capacity;
    const hasCharging = station.smetadata?.netex_parking?.charging === true;
    const municipality = station.smetadata?.municipality;

    staticRows.push({
      poiId: station.scode,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: getStationName(station),
        parkingType: deriveLayout(station),
        capacity,
        address: municipality ? `${municipality}, South Tyrol` : "South Tyrol, Italy",
        chargingSpaces: hasCharging ? 1 : undefined,
        chargingDetails: hasCharging ? "EV Charging Available" : undefined,
      },
    });

    const meas = measMap.get(station.scode);
    if (meas && (meas.free !== undefined || meas.occupied !== undefined)) {
      let freeSpaces: number | undefined;
      if (meas.free !== undefined) {
        freeSpaces = meas.free;
      } else if (meas.occupied !== undefined && typeof capacity === "number") {
        freeSpaces = Math.max(0, capacity - meas.occupied);
      }
      live.set(station.scode, {
        asOf: meas.asOf,
        freeSpaces: freeSpaces ?? null,
        capacity: capacity ?? null,
      });
    }
  }

  return { static: staticRows, live };
};
