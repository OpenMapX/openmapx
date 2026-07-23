import type { EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveParseFn, PoiLiveState, PoiSourceLogger } from "@openmapx/poi-source-registry";
import {
  DE_OCPDB_LOCATIONS_URL,
  fetchAllOcpdbItems,
  realtimeSourceUids,
  sourceUidUrl,
} from "./de-ocpdb-client.js";
import { deOcpdbLocationPoiId } from "./utils.js";

// The OCPDB OCPI Locations feed carries `evses[].status` directly on each
// location. The seed buffer is a `/sources` response; we derive the sources
// that carry realtime data and page only those via `source_uid` — skipping the
// static BNetzA bulk (~63% of locations). OCPDB statuses also include "STATIC"
// (rows with no realtime) — classifyEvseStatus returns null for it, so those
// stations report "unknown" with no availability counts.
interface OcpdbEvse {
  status?: string;
}

interface OcpdbLocation {
  id?: string;
  evses?: OcpdbEvse[];
}

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

async function parse(
  sourcesSeed: Buffer,
  log: PoiSourceLogger,
): Promise<Map<string, PoiLiveState>> {
  // Throw (don't return an empty map) on total failure: the write-live stage
  // DELs the Redis hash and only rewrites when the map is non-empty, so an empty
  // return would instantly wipe all availability on a transient upstream failure
  // (e.g. a 200 maintenance/WAF page for /sources that `realtimeSourceUids`
  // can't parse). Erroring aborts the pipeline before write-live, leaving the
  // last good snapshot to serve until its 2 h TTL — the "one missed run stays
  // warm" behaviour the design promises.
  const sourceUids = realtimeSourceUids(sourcesSeed);
  if (sourceUids.length === 0) {
    throw new Error(
      "de-ocpdb-live-parser: no realtime sources resolved from /sources (empty or non-JSON response) — keeping last availability",
    );
  }

  const locations: unknown[] = [];
  for (const uid of sourceUids) {
    locations.push(...(await fetchAllOcpdbItems(sourceUidUrl(DE_OCPDB_LOCATIONS_URL, uid), log)));
  }
  if (locations.length === 0) {
    throw new Error(
      "de-ocpdb-live-parser: all realtime sources returned zero locations — keeping last availability",
    );
  }

  const out = new Map<string, PoiLiveState>();
  // The pages are a bulk snapshot the hourly live cron re-fetches — the EVSE
  // statuses are only as fresh as OUR poll, not each location's own
  // `last_updated`. Stamp every row with OUR parse time (computed once) so the
  // two-tier staleness guard doesn't reject fresh data as stale.
  const asOf = new Date().toISOString();

  for (const raw of locations) {
    if (!raw || typeof raw !== "object") continue;
    const location = raw as OcpdbLocation;
    // MUST derive poiId identically to de-ocpdb-parser.ts (same shared helper)
    // — otherwise live status never joins to its static station row.
    const poiId = deOcpdbLocationPoiId(location);
    if (!poiId) continue;

    const statuses: Array<EvChargingStatus | null> = [];
    let available = 0;
    let total = 0;
    for (const evse of location.evses ?? []) {
      const status = (evse.status ?? "").toUpperCase();
      if (status === "AVAILABLE") available += 1;
      if (status !== "REMOVED") total += 1;
      statuses.push(classifyEvseStatus(evse.status));
    }

    // Only attach counts when at least one EVSE resolved to a known status —
    // otherwise a station of all-"STATIC" EVSEs would render a misleading
    // "0 of N available" once merged.
    const hasKnownStatus = statuses.some((status) => status !== null);
    out.set(poiId, {
      asOf,
      status: aggregateStationStatus(statuses),
      ...(hasKnownStatus ? { available, total } : {}),
    });
  }
  return out;
}

export const parseDeOcpdbLive: PoiLiveParseFn = (buffer, { log }) => parse(buffer, log);
