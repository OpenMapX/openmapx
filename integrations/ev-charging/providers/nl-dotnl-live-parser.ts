import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";
import { summarizeEvseStatuses } from "./evse-status.js";
import { nlDotnlLocationPoiId } from "./utils.js";

// Unlike the Swiss OICP feed (status keyed by EvseID in a separate feed, with
// no station backref), the DOT-NL OCPI Locations file carries `evses[].status`
// directly on each location — so the live cron re-fetches the SAME locations
// URL (see nl-dotnl-parser.ts's NL_DOTNL_LOCATIONS_URL) and this parser needs
// no extra fetch to resolve evse→station.
interface OcpiEvse {
  status?: string;
}

interface OcpiLocation {
  id?: string;
  country_code?: string;
  party_id?: string;
  evses?: OcpiEvse[];
}

export const parseNlDotnlLive: PoiLiveParseFn = (buffer) => {
  const locations = JSON.parse(buffer.toString("utf-8")) as unknown;
  const out = new Map<string, PoiLiveState>();
  if (!Array.isArray(locations)) return out;

  // The DOT-NL locations file is a bulk snapshot the live cron re-fetches
  // every 15 min — the EVSE statuses inside it are only as fresh as OUR poll,
  // not the location's own `last_updated` (which reflects when the CPO last
  // edited the record, often hours ago). Stamping every row with OUR parse
  // time — computed once so all rows share one consistent value — keeps the
  // two-tier merge's staleness guard (`isLiveTooStale`, 30 min) from
  // rejecting fresh data as stale.
  const asOf = new Date().toISOString();

  for (const raw of locations) {
    if (!raw || typeof raw !== "object") continue;
    const location = raw as OcpiLocation;
    // MUST derive poiId identically to nl-dotnl-parser.ts (same shared
    // helper) — otherwise live status never joins to its static station row.
    const poiId = nlDotnlLocationPoiId(location);
    if (!poiId) continue;

    // Every EVSE on the location counts toward `total`, including ones whose
    // status string the shared summarizer doesn't recognize — they're still a
    // real physical EVSE (mirrors the fix already applied to the CH parser).
    // REMOVED means the EVSE is no longer part of the location, so it's
    // excluded from `total` (and thus `available`, which only counts
    // AVAILABLE anyway) — but it still feeds the aggregate station status.
    const summary = summarizeEvseStatuses((location.evses ?? []).map((evse) => evse.status));

    // A station where every classifiable EVSE came back with an unrecognized
    // status (or there are no EVSEs at all) carries no meaningful
    // availability signal — emitting available:0/total:N here would render
    // as a misleading "0 of N available" once merged. Only attach the counts
    // when at least one EVSE resolved to a known status.
    out.set(poiId, {
      asOf,
      status: summary.status,
      ...(summary.hasKnownStatus ? { available: summary.available, total: summary.total } : {}),
    });
  }
  return out;
};
