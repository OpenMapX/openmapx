import type { DataSourceAttribution } from "@openmapx/core";
import type {
  EvChargingAddress,
  EvChargingConnector,
  EvChargingOperator,
  EvChargingStation,
  EvChargingStatus,
  EvChargingTariff,
} from "@openmapx/mobility-core/ev-charging";

/**
 * Shared rehydrator for poi-ingest EV sources whose parser persists a canonical
 * payload (the same field names as {@link EvChargingStation}, minus the derived
 * `id`/`sources`). Bulk national feeds — Ireland ESB, Spain DGT, Cyprus CYNAP,
 * New Zealand EVRoam, Finland, … — all store this shape, so they share ONE
 * mapper instead of hand-rolling a bespoke `mapXPayload` each. The static
 * parser is the single place that normalizes source quirks into this payload;
 * the reader just reads it back.
 *
 * A source with a live tier still uses this for the static base and supplies
 * its own `mergeWithLive`.
 */

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinates(value: unknown): [number, number] {
  if (Array.isArray(value)) {
    const lng = num(value[0]);
    const lat = num(value[1]);
    if (lng !== undefined && lat !== undefined) return [lng, lat];
  }
  return [0, 0];
}

function address(value: unknown): EvChargingAddress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const out: EvChargingAddress = {
    line1: str(a.line1),
    town: str(a.town),
    state: str(a.state),
    postcode: str(a.postcode),
    country: str(a.country),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

function operator(value: unknown): EvChargingOperator | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return undefined;
  return { name, url: str(o.url), legalName: str(o.legalName) };
}

function status(value: unknown): EvChargingStatus {
  if (
    value === "operational" ||
    value === "not-operational" ||
    value === "planned" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function connectors(value: unknown): EvChargingConnector[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is EvChargingConnector => typeof v === "object" && v !== null);
}

function tariffs(value: unknown): EvChargingTariff[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is EvChargingTariff => typeof v === "object" && v !== null);
  return out.length > 0 ? out : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

function attributions(value: unknown): DataSourceAttribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (v): v is DataSourceAttribution =>
      typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string",
  );
  return out.length > 0 ? out : undefined;
}

/**
 * Builds a `mapStatic(poiId, payload)` for {@link createStaticPoiReader} /
 * {@link createTwoTierPoiReader}. The returned station id is
 * `${stationIdPrefix}${poiId}` and `sources` is `[sourceId]`.
 */
export function createPayloadStationMapper(opts: {
  sourceId: string;
  stationIdPrefix: string;
}): (poiId: string, payload: unknown) => EvChargingStation {
  const { sourceId, stationIdPrefix } = opts;
  return (poiId, payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const stationId = `${stationIdPrefix}${poiId}`;
    return {
      id: stationId,
      sources: [sourceId],
      sourceItemIds: [stationId],
      name: str(p.name) ?? "EV Charging Station",
      coordinates: coordinates(p.coordinates),
      attributions: attributions(p.attributions),
      address: address(p.address),
      operator: operator(p.operator),
      status: status(p.status),
      connectors: connectors(p.connectors),
      tariffs: tariffs(p.tariffs),
      usageType: str(p.usageType),
      usageCost: str(p.usageCost),
      openingHours: str(p.openingHours),
      access: str(p.access),
      paymentMethods: stringArray(p.paymentMethods),
      updatedAt: str(p.updatedAt),
      sourceUrl: str(p.sourceUrl),
      notes: stringArray(p.notes),
    };
  };
}
