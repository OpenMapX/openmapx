import type { ParkApiV2City, ParkApiV2Lot, ParkingType } from "@openmapx/mobility-core/parking";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for ParkAPI v2 (ParkenDD).
 *
 * The federated nature of the ParkenDD API is awkward inside the
 * one-fetch-per-cron data-manager model:
 *   - the configured fetch hits `https://api.parkendd.de`, which returns the
 *     city catalog only;
 *   - the per-city lot lists live at `https://api.parkendd.de/<cityName>` and
 *     must be fetched separately for every active city (~30 today).
 *
 * Three options were considered:
 *   A) declare ~80 PoiSource entries, one per city — explodes the registry,
 *      multiplies cron load, and forces operators to manage one ingest record
 *      per city. Hard pass.
 *   B) implement `resolveUrl` to cycle through cities — only ingests one
 *      city per cron fire, so a 30-city catalog needs 150 minutes of cron
 *      ticks for a complete refresh. Unacceptable for live data.
 *   C) keep ONE source, do the city fan-out inside the parser, fetching with
 *      `globalThis.fetch` and a small concurrency limiter.
 *
 * We picked C. This is a deliberate exception to the "parser is pure" rule:
 *   - data-manager budgets the fetch+parse stages together (timeoutMs is
 *     applied to the catalog fetch; the per-city fan-out lives inside the
 *     parser's wall-clock budget, which is generous for bundled runs);
 *   - the parser still returns the canonical { static: PoiRow[], live: Map }
 *     shape, so downstream stages (validate, upsert, swap, write-live) see
 *     no difference;
 *   - concurrency is capped at PARKAPI_V2_CONCURRENCY so we don't hammer the
 *     upstream.
 *
 * If the upstream ever exposes a single endpoint with all cities' lots, this
 * file should be the only place we need to touch.
 */

const API_BASE = "https://api.parkendd.de";
const PER_CITY_TIMEOUT_MS = 10_000;
const PARKAPI_V2_CONCURRENCY = 5;

const LOT_TYPE_MAP: Record<string, ParkingType> = {
  Tiefgarage: "underground",
  Parkhaus: "garage",
  Parkplatz: "surface",
};

function mapLotType(lotType?: string): ParkingType {
  if (!lotType) return "unknown";
  return LOT_TYPE_MAP[lotType] ?? "unknown";
}

function mapState(state?: string): "open" | "closed" | "unknown" {
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return "unknown";
}

async function fetchCityLots(cityName: string): Promise<ParkApiV2Lot[]> {
  const url = `${API_BASE}/${encodeURIComponent(cityName)}`;
  const res = await globalThis.fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PER_CITY_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { lots?: ParkApiV2Lot[] };
  return data.lots ?? [];
}

/**
 * Bounded parallelism without pulling in p-limit/p-queue. Items are pulled
 * off a shared queue by `concurrency` workers; results land in the same
 * slot they were enqueued from so the caller can index them by city order.
 */
async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

function parseCityCatalog(buffer: Buffer, log: PoiSourceLogger): Map<string, ParkApiV2City> {
  try {
    const raw = JSON.parse(buffer.toString("utf-8")) as {
      cities?: Record<string, ParkApiV2City>;
    };
    const cityMap = raw.cities ?? {};
    const cities = new Map<string, ParkApiV2City>();
    for (const [name, city] of Object.entries(cityMap)) {
      if (!city?.coords) continue;
      if (!city.active_support) continue;
      cities.set(name, { ...city, name });
    }
    return cities;
  } catch (err) {
    log.warn("parkapi-v2: failed to parse city catalog", { error: (err as Error).message });
    return new Map();
  }
}

export function makeParkApiV2BundledParser(): PoiBundledParseFn {
  return async (buffer, { log }) => {
    const cities = parseCityCatalog(buffer, log);
    if (cities.size === 0) {
      return { static: [], live: new Map<string, PoiLiveState>() };
    }
    const cityNames = Array.from(cities.keys());

    // Per-city fetches may fail individually; degrade gracefully so a single
    // upstream hiccup doesn't poison the whole ingest run.
    const settledLots = await mapWithConcurrency(
      cityNames,
      PARKAPI_V2_CONCURRENCY,
      async (name) => {
        try {
          return { name, lots: await fetchCityLots(name) };
        } catch (err) {
          log.warn("parkapi-v2: city fetch failed", { city: name, error: (err as Error).message });
          return { name, lots: [] as ParkApiV2Lot[] };
        }
      },
    );

    const staticRows: PoiRow[] = [];
    const live = new Map<string, PoiLiveState>();
    const now = new Date().toISOString();

    for (const { name: cityName, lots } of settledLots) {
      for (const lot of lots) {
        if (!lot.coords) continue;
        if (!lot.id) continue;
        const poiId = `${cityName}/${lot.id}`;
        const lng = lot.coords.lng;
        const lat = lot.coords.lat;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        staticRows.push({
          poiId,
          lng,
          lat,
          payload: {
            coordinates: [lng, lat] as [number, number],
            name: lot.name,
            parkingType: mapLotType(lot.lot_type),
            capacity: lot.total ?? undefined,
            address: lot.address ?? undefined,
            state: mapState(lot.state),
            // Preserve the per-city source label for the in-memory provider's
            // dedup heuristic (it groups by full source label).
            source: `parkapi-v2/${cityName}`,
          },
        });

        const hasRealtime = lot.free !== undefined && lot.free !== null;
        if (hasRealtime) {
          live.set(poiId, {
            asOf: now,
            freeSpaces: lot.free as number,
            state: mapState(lot.state),
          });
        }
      }
    }

    return { static: staticRows, live };
  };
}
