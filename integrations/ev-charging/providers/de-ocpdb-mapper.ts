import { isLiveTooStale } from "@openmapx/integration-framework";
import type { EvChargingStation, EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

// The static tier rehydrates via the shared createPayloadStationMapper (see
// de-ocpdb.ts); only the live-merge stays source-specific and lives here.
//
// The live cron pages the OCPDB realtime sources hourly; ttlSeconds is set to
// 2x that interval (120 min) in poi-sources.ts. Keep the merge-side staleness
// guard aligned with that Redis TTL — 2× the interval — so availability
// survives one full cycle plus a skipped run rather than flickering to
// "unknown" late in each hour, while never trusting data already expired.
const MAX_LIVE_AGE_MS = 2 * 60 * 60 * 1000;

function asLiveStatus(value: unknown): EvChargingStatus | undefined {
  if (
    value === "operational" ||
    value === "not-operational" ||
    value === "planned" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

export function mergeDeOcpdbLive(
  base: EvChargingStation,
  live: PoiLiveState | null,
): EvChargingStation {
  if (!live) return base;
  const status = asLiveStatus((live as { status?: unknown }).status);
  if (!status) return base;
  // When upstream is stale, retain the last-known status value but mark it
  // unknown so consumers don't trust a long-cached "operational" reading.
  if (isLiveTooStale(live, MAX_LIVE_AGE_MS)) {
    return { ...base, status: "unknown" };
  }

  const available = (live as { available?: unknown }).available;
  const total = (live as { total?: unknown }).total;
  const availability =
    typeof available === "number" && typeof total === "number"
      ? { available, total, updatedAt: live.asOf }
      : undefined;

  return { ...base, status, isLive: true, ...(availability ? { availability } : {}) };
}
