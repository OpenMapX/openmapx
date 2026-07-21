import type { AutobahnParkingLorry } from "@openmapx/mobility-core/parking";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for German Autobahn truck/car parking.
 *
 * The Autobahn GmbH API is doubly-federated:
 *   1. `GET /o/autobahn`               → list of all road identifiers (A1, A2…)
 *   2. `GET /o/autobahn/<road>/services/parking_lorry` → parking sites per road
 *
 * The data-manager fetch points at step (1). Step (2) fans out across ~70
 * roads inside this parser via `globalThis.fetch` with bounded parallelism.
 * Same WHY as `de-parkapi-v2-bundled-parser.ts`: declaring one PoiSource per
 * road would explode the registry and quadruple cron load; one source with
 * an in-parser fan-out keeps the durable table consistent.
 *
 * `isBlocked` is treated as static state — Autobahn doesn't surface real-time
 * occupancy counts. We emit a static-only result (empty live map), so this
 * source is effectively "bundled but with no live tier" — declared as
 * `static` in the registry to keep the ingest semantics honest.
 */

const ROADS_BASE = "https://verkehr.autobahn.de/o/autobahn";
const PER_ROAD_TIMEOUT_MS = 15_000;
const ROADS_CONCURRENCY = 5;

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

function hasAmenity(
  icons: AutobahnParkingLorry["lorryParkingFeatureIcons"],
  keyword: string,
): boolean {
  return icons?.some((i) => i.icon.includes(keyword) || i.description.includes(keyword)) ?? false;
}

function parseCapacity(description: string[]): { car?: number; truck?: number } {
  let car: number | undefined;
  let truck: number | undefined;
  for (const line of description) {
    const carMatch = line.match(/PKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (carMatch) car = Number.parseInt(carMatch[1], 10);
    const truckMatch = line.match(/LKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (truckMatch) truck = Number.parseInt(truckMatch[1], 10);
  }
  return { car, truck };
}

async function fetchRoadParking(
  road: string,
  log: PoiSourceLogger,
): Promise<AutobahnParkingLorry[]> {
  const url = `${ROADS_BASE}/${encodeURIComponent(road)}/services/parking_lorry`;
  try {
    const res = await globalThis.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PER_ROAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Individual road misses are common and noisy; debug-log only.
      log.debug?.("de-autobahn: road fetch returned non-2xx", { road, status: res.status });
      return [];
    }
    const data = (await res.json()) as { parking_lorry?: AutobahnParkingLorry[] };
    return data.parking_lorry ?? [];
  } catch (err) {
    log.warn("de-autobahn: road fetch failed", { road, error: (err as Error).message });
    return [];
  }
}

export const parseDeAutobahnBundled: PoiBundledParseFn = async (buffer, { log }) => {
  let roads: string[];
  try {
    const parsed = JSON.parse(buffer.toString("utf-8")) as { roads?: string[] };
    roads = parsed.roads ?? [];
  } catch (err) {
    log.warn("de-autobahn: failed to parse roads list", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const perRoad = await mapWithConcurrency(roads, ROADS_CONCURRENCY, (road) =>
    fetchRoadParking(road, log),
  );

  const staticRows: PoiRow[] = [];
  const seen = new Set<string>();

  for (const items of perRoad) {
    for (const item of items) {
      if (item.future === true) continue;
      const lat = Number.parseFloat(item.coordinate?.lat);
      const lng = Number.parseFloat(item.coordinate?.long);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const poiId = item.identifier;
      if (!poiId) continue;
      if (seen.has(poiId)) continue;
      seen.add(poiId);

      const { car, truck } = parseCapacity(item.description ?? []);
      const totalCapacity = (car ?? 0) + (truck ?? 0);
      const isBlocked = item.isBlocked === "true";
      const icons = item.lorryParkingFeatureIcons ?? [];
      const hasCharging = hasAmenity(icons, "charging") || hasAmenity(icons, "Ladestation");

      staticRows.push({
        poiId,
        lng,
        lat,
        payload: {
          coordinates: [lng, lat] as [number, number],
          name: item.subtitle || item.title || "Rastplatz",
          parkingType: "surface",
          capacity: totalCapacity > 0 ? totalCapacity : undefined,
          fee: "free",
          state: isBlocked ? "closed" : "open",
          chargingSpaces: hasCharging ? 1 : undefined,
          chargingDetails: hasCharging ? "EV Charging Available" : undefined,
        },
      });
    }
  }

  return { static: staticRows, live: new Map<string, PoiLiveState>() };
};
