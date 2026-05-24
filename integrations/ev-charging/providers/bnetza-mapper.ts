import type {
  EvChargingAddress,
  EvChargingConnector,
  EvChargingOperator,
  EvChargingStation,
  EvChargingStatus,
} from "@openmapx/mobility-core/ev-charging";

// Prefix preserved at "bnetza:" — the integration id rename to "bnetza-ev" is
// intentionally a registry-only change so existing place ids and downstream
// caches don't have to migrate.
const STATION_ID_PREFIX = "bnetza:";
const SOURCE_ID = "bnetza-ev";

function asStringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArrayOrUndef(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

function asAddress(value: unknown): EvChargingAddress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const out: EvChargingAddress = {
    line1: asStringOrUndef(a.line1),
    town: asStringOrUndef(a.town),
    state: asStringOrUndef(a.state),
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

function asStatus(value: unknown): EvChargingStatus | undefined {
  if (
    value === "operational" ||
    value === "not-operational" ||
    value === "planned" ||
    value === "unknown"
  )
    return value;
  return undefined;
}

function asConnectors(value: unknown): EvChargingConnector[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is EvChargingConnector => typeof v === "object" && v !== null);
}

export function mapBnetzaPayload(poiId: string, payload: unknown): EvChargingStation {
  // Treat every field defensively — payload shapes can drift between the
  // parser version that wrote the row and the API version reading it back.
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
    status: asStatus(p.status),
    usageType: asStringOrUndef(p.usageType),
    usageCost: asStringOrUndef(p.usageCost),
    openingHours: asStringOrUndef(p.openingHours),
    access: asStringOrUndef(p.access),
    paymentMethods: asStringArrayOrUndef(p.paymentMethods),
    connectors: asConnectors(p.connectors),
    updatedAt: asStringOrUndef(p.updatedAt),
    sourceUrl: asStringOrUndef(p.sourceUrl),
  };
}
