import type { ParkApiV3Site, ParkApiV3Source, ParkingType } from "@openmapx/mobility-core/parking";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for ParkAPI v3 (MobiData BW).
 *
 * The MobiData BW endpoint returns ONE payload containing both static metadata
 * AND realtime occupancy per site, so a single fetch powers the durable
 * poi_ingest table and the per-poi live Redis hash. No federation needed.
 *
 * The source attribution table is a SECOND endpoint (`/sources`). We fetch it
 * inside the parser via `globalThis.fetch` and cache the lookup map in a
 * closure for SOURCE_LOOKUP_TTL_MS. WHY this is OK:
 *   - the parser is invoked once per cron fire (every 5min); the cache
 *     amortises the lookup across runs without violating the "one parser
 *     invocation = one source-list fetch" budget.
 *   - the sources catalog drifts on the order of weeks, so a 10-minute TTL
 *     keeps every parse run within ~one extra HTTP call.
 *   - if `/sources` fails the parser falls back to whatever lookup it has
 *     (possibly empty); sites still emit, just without enriched attribution.
 *
 * Sites are skipped when:
 *   - purpose is set to something other than "CAR" (bike/truck/etc are out of
 *     scope for the parking domain provider)
 *   - lat/lon are missing or unparseable.
 */

const SOURCES_API = "https://api.mobidata-bw.de/park-api/api/public/v3/sources";
const SOURCES_TIMEOUT_MS = 10_000;
const SOURCE_LOOKUP_TTL_MS = 10 * 60 * 1000;

const TYPE_MAP: Record<string, ParkingType> = {
  UNDERGROUND: "underground",
  CAR_PARK: "garage",
  OFF_STREET_PARKING_GROUND: "surface",
  ON_STREET: "on-street",
};

function mapType(type?: string): ParkingType {
  if (!type) return "unknown";
  return TYPE_MAP[type] ?? "unknown";
}

function normalizeSourceAttribution(source: ParkApiV3Source | undefined) {
  if (!source) return undefined;
  const license = source.attribution_license?.trim() || undefined;
  const contributor = source.attribution_contributor?.trim() || undefined;
  const url = source.attribution_url?.trim() || undefined;
  return {
    contributor,
    license,
    licenseUrl: url,
    name: contributor || source.name,
    url: source.public_url ?? undefined,
  };
}

export function makeDeParkapiV3BundledParser(): PoiBundledParseFn {
  // Closure-scoped cache; see WHY comment above the file header.
  let sourcesCache: { sources: Map<string, ParkApiV3Source>; fetchedAt: number } | null = null;

  async function fetchSources(log: PoiSourceLogger): Promise<Map<string, ParkApiV3Source>> {
    const now = Date.now();
    if (sourcesCache && now - sourcesCache.fetchedAt < SOURCE_LOOKUP_TTL_MS) {
      return sourcesCache.sources;
    }
    try {
      const res = await globalThis.fetch(SOURCES_API, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(SOURCES_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn("parkapi-v3: sources lookup returned non-2xx", { status: res.status });
        return sourcesCache?.sources ?? new Map();
      }
      const data = (await res.json()) as { items?: ParkApiV3Source[] } | ParkApiV3Source[];
      const raw = Array.isArray(data) ? data : (data.items ?? []);
      const sources = new Map<string, ParkApiV3Source>(raw.map((s) => [s.uid, s]));
      sourcesCache = { sources, fetchedAt: now };
      return sources;
    } catch (err) {
      log.warn("parkapi-v3: sources lookup failed", { error: (err as Error).message });
      return sourcesCache?.sources ?? new Map();
    }
  }

  return async (buffer, { log }) => {
    const sources = await fetchSources(log);

    let data: { items?: ParkApiV3Site[] } | ParkApiV3Site[];
    try {
      data = JSON.parse(buffer.toString("utf-8")) as { items?: ParkApiV3Site[] } | ParkApiV3Site[];
    } catch (err) {
      log.warn("parkapi-v3: failed to parse sites JSON", { error: (err as Error).message });
      return { static: [], live: new Map<string, PoiLiveState>() };
    }
    const sites = Array.isArray(data) ? data : (data.items ?? []);

    const staticRows: PoiRow[] = [];
    const live = new Map<string, PoiLiveState>();

    for (const site of sites) {
      if (site.purpose && site.purpose !== "CAR") continue;

      const lat = site.lat != null ? Number.parseFloat(site.lat) : Number.NaN;
      const lon = site.lon != null ? Number.parseFloat(site.lon) : Number.NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const poiId = String(site.id);
      const source = site.source_uid ? sources.get(site.source_uid) : undefined;

      const staticDataUpdatedAt =
        site.static_data_updated_at ?? source?.static_data_updated_at ?? undefined;
      const realtimeDataUpdatedAt =
        site.realtime_data_updated_at ?? source?.realtime_data_updated_at ?? undefined;

      const capacity = site.capacity ?? site.realtime_capacity ?? undefined;
      const sourceAttribution = normalizeSourceAttribution(source);

      staticRows.push({
        poiId,
        lng: lon,
        lat,
        payload: {
          coordinates: [lon, lat] as [number, number],
          name: site.name,
          parkingType: mapType(site.type),
          capacity,
          disabledSpaces: site.capacity_disabled ?? undefined,
          chargingSpaces: site.capacity_charging ?? undefined,
          maxHeight: site.max_height ?? undefined,
          fee: site.has_fee === true ? "paid" : site.has_fee === false ? "free" : "unknown",
          feeDescription: site.fee_description ?? undefined,
          operator: site.operator_name ?? undefined,
          address: site.address ?? undefined,
          openingHours: site.opening_hours ?? undefined,
          url: site.public_url ?? undefined,
          sourceUid: site.source_uid ?? undefined,
          sourceName: source?.name,
          sourceUrl: source?.public_url ?? undefined,
          sourceAttribution,
          staticDataUpdatedAt,
        },
      });

      const hasRealtime =
        site.has_realtime_data === true && typeof site.realtime_free_capacity === "number";
      if (hasRealtime) {
        live.set(poiId, {
          asOf: realtimeDataUpdatedAt ?? new Date().toISOString(),
          freeSpaces: site.realtime_free_capacity as number,
          capacity: capacity ?? null,
        });
      }
    }

    return { static: staticRows, live };
  };
}
