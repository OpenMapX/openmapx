import { fetchJson } from "@openmapx/core";
import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";
import { summarizeEvseStatuses } from "./evse-status.js";

export const CH_SFOE_OICP_DATA_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";
export const CH_SFOE_OICP_STATUS_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/status/oicp/ch.bfe.ladestellen-elektromobilitaet.json";

interface ChSfoeEvseDataGroupShape {
  EVSEDataRecord?: Array<{
    ChargingStationId?: string;
    EvseID?: string;
  }>;
}
interface ChSfoeEvseDataFeedShape {
  EVSEData?: ChSfoeEvseDataGroupShape[];
}

interface ChSfoeEvseStatusGroupShape {
  EVSEStatusRecord?: Array<{ EvseID?: string; EVSEStatus?: string }>;
}
interface ChSfoeEvseStatusFeedShape {
  EVSEStatuses?: ChSfoeEvseStatusGroupShape[];
}

// The OICP status feed is keyed by EvseID alone — there's no station backref
// in each record. Aggregating to per-station status (the granularity poiIds
// use) therefore needs the EvseID→ChargingStationId map, which only the
// static data feed carries. The live parser pulls both URLs every run; the
// cost is one extra ~9k-record JSON per cron tick (every 5 min), well within
// the upstream's tolerance and Redis writes still land in a single MULTI.
async function fetchDataFeed(): Promise<ChSfoeEvseDataFeedShape> {
  const fetcher = globalThis.fetch;
  if (!fetcher) {
    throw new Error("ch-sfoe-live-parser: globalThis.fetch is not available");
  }
  return fetchJson<ChSfoeEvseDataFeedShape>(CH_SFOE_OICP_DATA_URL, {
    timeoutMs: 20_000,
    userAgent: null,
    errorMessage: ({ status }) => `ch-sfoe-live-parser: data feed fetch failed HTTP ${status}`,
  });
}

export const parseChSfoeOicpLive: PoiLiveParseFn = async (buffer, ctx) => {
  const statusFeed = JSON.parse(buffer.toString("utf-8")) as ChSfoeEvseStatusFeedShape;

  let dataFeed: ChSfoeEvseDataFeedShape;
  try {
    dataFeed = await fetchDataFeed();
  } catch (err) {
    ctx.log.warn(
      `ch-sfoe-live-parser: could not fetch static data feed for evse→station mapping: ${(err as Error).message}`,
    );
    return new Map<string, PoiLiveState>();
  }

  const evseToStation = new Map<string, string>();
  for (const group of dataFeed.EVSEData ?? []) {
    for (const rec of group.EVSEDataRecord ?? []) {
      const stationId = rec.ChargingStationId ?? rec.EvseID;
      if (!stationId) continue;
      const poiId = encodeURIComponent(stationId);
      if (rec.EvseID) evseToStation.set(rec.EvseID, poiId);
    }
  }

  const rawStatusesByStation = new Map<string, string[]>();
  for (const group of statusFeed.EVSEStatuses ?? []) {
    for (const rec of group.EVSEStatusRecord ?? []) {
      const evseId = rec.EvseID;
      if (!evseId) continue;
      const poiId = evseToStation.get(evseId);
      if (!poiId) continue;

      // Every EVSE record for this station is recorded here, including ones
      // whose status string the shared summarizer doesn't recognize — they're
      // still a real physical EVSE and must count toward `total`.
      const raw = rec.EVSEStatus?.toUpperCase() ?? "";
      const rawBucket = rawStatusesByStation.get(poiId);
      if (rawBucket) rawBucket.push(raw);
      else rawStatusesByStation.set(poiId, [raw]);
    }
  }

  const asOf = new Date().toISOString();
  const out = new Map<string, PoiLiveState>();
  for (const [poiId, rawStatuses] of rawStatusesByStation) {
    const summary = summarizeEvseStatuses(rawStatuses);
    out.set(poiId, {
      asOf,
      status: summary.status,
      available: summary.available,
      total: summary.total,
    });
  }
  return out;
};
