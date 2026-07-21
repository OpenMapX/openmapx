import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stad Gent Opendatasoft v2.1 real-time garage bundled parser.
 *
 * A single fetch returns static descriptors plus live availability +
 * open/closed flags per garage. Pre-migration id was `ghent:${record.name}`,
 * which we preserve as the poiId.
 */

interface GhentRecord {
  name: string;
  lastupdate: string;
  totalcapacity: number;
  availablecapacity: number;
  occupation: number;
  type: string;
  description: string | null;
  id: string;
  openingtimesdescription: string | null;
  isopennow: number;
  temporaryclosed: number;
  operatorinformation: string | null;
  freeparking: number;
  urllinkaddress: string | null;
  occupancytrend: string | null;
  location: { lon: number; lat: number } | null;
  categorie: string | null;
}

interface GhentResponse {
  total_count: number;
  results: GhentRecord[];
}

function deriveState(record: GhentRecord): "open" | "closed" | "unknown" {
  if (record.temporaryclosed === 1) return "closed";
  if (record.isopennow === 1) return "open";
  return "unknown";
}

export const parseBeVlgGhentBundled: PoiBundledParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: GhentResponse;
  try {
    data = JSON.parse(text) as GhentResponse;
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data?.results)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const fallbackAsOf = new Date().toISOString();

  for (const record of data.results) {
    if (!record?.name) continue;
    const lng = record.location?.lon;
    const lat = record.location?.lat;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const capacity = record.totalcapacity > 0 ? record.totalcapacity : undefined;

    staticRows.push({
      poiId: record.name,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.name,
        capacity,
        parkingType: "garage",
        fee: record.freeparking === 1 ? "free" : "paid",
        operator: record.operatorinformation ?? undefined,
        openingHours: record.openingtimesdescription ?? undefined,
        url: record.urllinkaddress ?? undefined,
      },
    });

    // `state` always travels via live because it depends on isopennow /
    // temporaryclosed, which can flip per response. `freeSpaces` likewise.
    const freeSpaces =
      record.availablecapacity != null && record.availablecapacity >= 0
        ? record.availablecapacity
        : undefined;
    live.set(record.name, {
      asOf: record.lastupdate || fallbackAsOf,
      freeSpaces,
      state: deriveState(record),
    });
  }

  return { static: staticRows, live };
};
