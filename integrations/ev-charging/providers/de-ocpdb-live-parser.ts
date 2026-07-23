import type { EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveParseFn, PoiLiveState, PoiSourceLogger } from "@openmapx/poi-source-registry";
import { DE_OCPDB_LOCATIONS_URL, fetchAllOcpdbItems } from "./de-ocpdb-client.js";
import { deOcpdbLocationPoiId } from "./utils.js";

// The OCPDB OCPI Locations feed carries `evses[].status` directly on each
// location (like DOT-NL), so the live cron re-pages the SAME locations feed and
// this parser needs no extra fetch to resolve evse→station. OCPDB statuses also
// include "STATIC" (BNetzA rows with no realtime) — classifyEvseStatus returns
// null for it, so those stations report "unknown" with no availability counts.
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

async function parse(seed: Buffer, log: PoiSourceLogger): Promise<Map<string, PoiLiveState>> {
  const locations = await fetchAllOcpdbItems(DE_OCPDB_LOCATIONS_URL, log, seed);
  const out = new Map<string, PoiLiveState>();

  // The feed is a bulk snapshot the live cron re-pages every 30 min — the EVSE
  // statuses inside it are only as fresh as OUR poll, not each location's own
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
