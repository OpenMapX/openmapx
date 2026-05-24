import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Basel-Stadt Opendatasoft v2.1 parking garage bundled parser.
 *
 * A single fetch ships both static garage metadata AND live free-space counts,
 * so we emit one PoiRow per record and one live-hash entry when `free` is set.
 * `id2` is the stable per-garage key (pre-migration id was `basel:${id2}`).
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

  for (const record of data.results) {
    const lng = record.geo_point_2d?.lon;
    const lat = record.geo_point_2d?.lat;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;
    if (!record.id2) continue;

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
