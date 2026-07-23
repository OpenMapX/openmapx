import { isLiveTooStale } from "@openmapx/integration-framework";
import type {
  EvChargingAddress,
  EvChargingConnector,
  EvChargingOperator,
  EvChargingStation,
  EvChargingStatus,
  EvChargingTariff,
} from "@openmapx/mobility-core/ev-charging";
import type { PoiLiveState } from "@openmapx/poi-source-registry";

// The live cron re-pages the OCPDB locations feed every 30 min; ttlSeconds is
// set to 2x that interval (60 min) in poi-sources.ts. Keep the merge-side
// staleness guard aligned with that Redis TTL so a search never trusts live
// data that's already expired from cache.
const MAX_LIVE_AGE_MS = 60 * 60 * 1000;

const STATION_ID_PREFIX = "de-ocpdb:";
const SOURCE_ID = "de-ocpdb";

function asStringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asAddress(value: unknown): EvChargingAddress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const out: EvChargingAddress = {
    line1: asStringOrUndef(a.line1),
    town: asStringOrUndef(a.town),
    postcode: asStringOrUndef(a.postcode),
    country: asStringOrUndef(a.country),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

function asOperator(value: unknown): EvChargingOperator | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const name = asStringOrUndef(o.name);
  if (!name) return undefined;
  return { name };
}

function asConnectors(value: unknown): EvChargingConnector[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is EvChargingConnector => typeof v === "object" && v !== null);
}

function asTariffs(value: unknown): EvChargingTariff[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is EvChargingTariff => typeof v === "object" && v !== null);
  return out.length > 0 ? out : undefined;
}

export function mapDeOcpdbPayload(poiId: string, payload: unknown): EvChargingStation {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const stationId = `${STATION_ID_PREFIX}${poiId}`;

  const coordinates = Array.isArray(p.coordinates)
    ? ([p.coordinates[0] as number, p.coordinates[1] as number] as [number, number])
    : ([0, 0] as [number, number]);

  return {
    id: stationId,
    sources: [SOURCE_ID],
    sourceItemIds: [stationId],
    name: asStringOrUndef(p.name) ?? "EV Charging Station",
    coordinates,
    address: asAddress(p.address),
    operator: asOperator(p.operator),
    // Static-only ingest: live per-EVSE status returns later via the live spec.
    status: "unknown",
    connectors: asConnectors(p.connectors),
    tariffs: asTariffs(p.tariffs),
    updatedAt: asStringOrUndef(p.updatedAt),
  };
}

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
