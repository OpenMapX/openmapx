import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Basel-Stadt Opendatasoft v2.1 parking garage bundled parser.
 *
 * A single fetch ships both static garage metadata AND live free-space counts,
 * so we emit one PoiRow per record and one live-hash entry when `free` is set.
 * `id2` is the stable per-garage key (pre-migration id was `basel:${id2}`).
 *
 * The upstream dataset is a TIME-SERIES (hourly snapshots × 16 active
 * facilities ≈ 1M rows). The source URL passes `order_by=published desc&limit=100`
 * — OpenDataSoft v2.1 caps `limit` at 100, but that's still ~6 snapshots'
 * worth, more than enough to cover every active facility with the newest
 * value landing first. Dedup-by-id2 below keeps only that first occurrence
 * per facility. Without dedup the staging-table primary-key constraint
 * fails on duplicate poi ids.
 */

interface BaselRecord {
  published: string;
  free: number;
  total: number;
  auslastungen: number | null;
  id: string;
  id2: string;
  title: string;
  name: string;
  address: string | null;
  link: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  description: string | null;
}

interface BaselResponse {
  total_count: number;
  results: BaselRecord[];
}

export const parseBaselChBundled: PoiBundledParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: BaselResponse;
  try {
    data = JSON.parse(text) as BaselResponse;
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data?.results)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  // Records arrive newest-first (URL has order_by=published desc). The first
  // occurrence of each id2 is therefore the freshest snapshot — skip subsequent
  // dupes for both static rows AND live state.
  const seen = new Set<string>();

  for (const record of data.results) {
    const lng = record.geo_point_2d?.lon;
    const lat = record.geo_point_2d?.lat;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;
    if (!record.id2) continue;
    if (seen.has(record.id2)) continue;
    seen.add(record.id2);

    const capacity = record.total > 0 ? record.total : undefined;

    staticRows.push({
      poiId: record.id2,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.title || record.name || "Parking",
        capacity,
        parkingType: "garage",
        fee: "paid",
        address: record.address ?? undefined,
        url: record.link ?? undefined,
      },
    });

    if (record.free != null && record.free >= 0) {
      live.set(record.id2, {
        asOf: record.published ?? new Date().toISOString(),
        freeSpaces: record.free,
      });
    }
  }

  return { static: staticRows, live };
};
