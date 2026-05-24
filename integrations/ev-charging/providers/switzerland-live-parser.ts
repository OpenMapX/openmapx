import type { EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";

export const SWISS_OICP_DATA_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";
export const SWISS_OICP_STATUS_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/status/oicp/ch.bfe.ladestellen-elektromobilitaet.json";

interface SwissEvseDataGroupShape {
  EVSEDataRecord?: Array<{
    ChargingStationId?: string;
    EvseID?: string;
  }>;
}
interface SwissEvseDataFeedShape {
  EVSEData?: SwissEvseDataGroupShape[];
}

interface SwissEvseStatusGroupShape {
  EVSEStatusRecord?: Array<{ EvseID?: string; EVSEStatus?: string }>;
}
interface SwissEvseStatusFeedShape {
  EVSEStatuses?: SwissEvseStatusGroupShape[];
}

// The OICP status feed is keyed by EvseID alone — there's no station backref
// in each record. Aggregating to per-station status (the granularity poiIds
// use) therefore needs the EvseID→ChargingStationId map, which only the
// static data feed carries. The live parser pulls both URLs every run; the
// cost is one extra ~9k-record JSON per cron tick (every 5 min), well within
// the upstream's tolerance and Redis writes still land in a single MULTI.
function classifyEvseStatus(raw: string | undefined): EvChargingStatus | null {
  const upper = raw?.toUpperCase() ?? "";
  if (upper === "AVAILABLE" || upper === "CHARGING" || upper === "BLOCKED" || upper === "RESERVED")
    return "operational";
  if (upper === "PLANNED") return "planned";
  if (upper === "INOPERATIVE" || upper === "OUTOFORDER" || upper === "REMOVED")
    return "not-operational";
  return null;
}

function aggregateStationStatus(perEvse: ReadonlyArray<EvChargingStatus | null>): EvChargingStatus {
  let sawOperational = false;
  let sawPlanned = false;
  let sawNotOperational = false;
  let sawKnown = false;
  for (const s of perEvse) {
    if (s === null) continue;
    sawKnown = true;
    if (s === "operational") sawOperational = true;
    else if (s === "planned") sawPlanned = true;
    else if (s === "not-operational") sawNotOperational = true;
  }
  if (!sawKnown) return "unknown";
  if (sawOperational) return "operational";
  if (sawPlanned) return "planned";
  if (sawNotOperational) return "not-operational";
  return "unknown";
}

async function fetchDataFeed(): Promise<SwissEvseDataFeedShape> {
  const fetcher = globalThis.fetch;
  if (!fetcher) {
    throw new Error("switzerland-live-parser: globalThis.fetch is not available");
  }
  const res = await fetcher(SWISS_OICP_DATA_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`switzerland-live-parser: data feed fetch failed HTTP ${res.status}`);
  }
  return (await res.json()) as SwissEvseDataFeedShape;
}

export const parseSwissOicpLive: PoiLiveParseFn = async (buffer, ctx) => {
  const statusFeed = JSON.parse(buffer.toString("utf-8")) as SwissEvseStatusFeedShape;

  let dataFeed: SwissEvseDataFeedShape;
  try {
    dataFeed = await fetchDataFeed();
  } catch (err) {
    ctx.log.warn(
      `switzerland-live-parser: could not fetch static data feed for evse→station mapping: ${(err as Error).message}`,
    );
    return new Map<string, PoiLiveState>();
  }

  const evseToStation = new Map<string, string>();
  const stationToEvses = new Map<string, string[]>();
  for (const group of dataFeed.EVSEData ?? []) {
    for (const rec of group.EVSEDataRecord ?? []) {
      const stationId = rec.ChargingStationId ?? rec.EvseID;
      if (!stationId) continue;
      const poiId = encodeURIComponent(stationId);
      if (rec.EvseID) evseToStation.set(rec.EvseID, poiId);
      const list = stationToEvses.get(poiId);
      if (list) {
        if (rec.EvseID) list.push(rec.EvseID);
      } else {
        stationToEvses.set(poiId, rec.EvseID ? [rec.EvseID] : []);
      }
    }
  }

  const perStation = new Map<string, Array<EvChargingStatus | null>>();
  for (const group of statusFeed.EVSEStatuses ?? []) {
    for (const rec of group.EVSEStatusRecord ?? []) {
      const evseId = rec.EvseID;
      if (!evseId) continue;
      const poiId = evseToStation.get(evseId);
      if (!poiId) continue;
      const bucket = perStation.get(poiId);
      const classified = classifyEvseStatus(rec.EVSEStatus);
      if (bucket) bucket.push(classified);
      else perStation.set(poiId, [classified]);
    }
  }

  const asOf = new Date().toISOString();
  const out = new Map<string, PoiLiveState>();
  for (const [poiId, statuses] of perStation) {
    out.set(poiId, { asOf, status: aggregateStationStatus(statuses) });
  }
  return out;
};
