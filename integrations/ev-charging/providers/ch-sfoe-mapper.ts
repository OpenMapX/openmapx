import { isLiveTooStale } from "@openmapx/integration-framework";
import type { EvChargingStation, EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

// The static tier rehydrates via the shared createPayloadStationMapper (see
// ch-sfoe.ts); the parser stores the EVSE id under payload.extraItemIds so the
// shared mapper still emits the second sourceItemId. Only the live-merge stays
// source-specific and lives here.
//
// Swiss OICP cron is */5 min; flag as not-operational/unknown if upstream
// hasn't refreshed for >30 min (=6 missed runs).
const MAX_LIVE_AGE_MS = 30 * 60 * 1000;

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

export function mergeChSfoeLive(
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
