import type { EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";

// Unlike the Swiss OICP feed (status keyed by EvseID in a separate feed, with
// no station backref), the DOT-NL OCPI Locations file carries `evses[].status`
// directly on each location — so the live cron re-fetches the SAME locations
// URL (see netherlands-parser.ts's DOTNL_LOCATIONS_URL) and this parser needs
// no extra fetch to resolve evse→station.
interface OcpiEvse {
  status?: string;
}

interface OcpiLocation {
  id?: string;
  last_updated?: string;
  evses?: OcpiEvse[];
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

export const parseDotNlLive: PoiLiveParseFn = (buffer) => {
  const locations = JSON.parse(buffer.toString("utf-8")) as unknown;
  const out = new Map<string, PoiLiveState>();
  if (!Array.isArray(locations)) return out;

  const fallbackAsOf = new Date().toISOString();
  for (const raw of locations) {
    if (!raw || typeof raw !== "object") continue;
    const location = raw as OcpiLocation;
    const id = typeof location.id === "string" && location.id.length > 0 ? location.id : undefined;
    if (!id) continue;
    const poiId = encodeURIComponent(id);

    const statuses: Array<EvChargingStatus | null> = [];
    let available = 0;
    // Every EVSE on the location counts toward `total`, including ones whose
    // status string `classifyEvseStatus` doesn't recognize — they're still a
    // real physical EVSE (mirrors the fix already applied to the CH parser).
    // REMOVED means the EVSE is no longer part of the location, so it's
    // excluded from `total` (and thus `available`, which only counts
    // AVAILABLE anyway) — but it still feeds the aggregate station status.
    let total = 0;
    for (const evse of location.evses ?? []) {
      const status = (evse.status ?? "").toUpperCase();
      if (status === "AVAILABLE") available += 1;
      if (status !== "REMOVED") total += 1;
      statuses.push(classifyEvseStatus(evse.status));
    }

    const asOf =
      typeof location.last_updated === "string" && location.last_updated.length > 0
        ? location.last_updated
        : fallbackAsOf;
    out.set(poiId, { asOf, status: aggregateStationStatus(statuses), available, total });
  }
  return out;
};
