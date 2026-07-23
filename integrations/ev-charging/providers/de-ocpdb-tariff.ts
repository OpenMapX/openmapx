import type {
  EvChargingPriceComponent,
  EvChargingTariff,
  EvChargingTariffRestriction,
  EvTariffDimension,
} from "@openmapx/mobility-core/ev-charging";
import { cleanString } from "./utils.js";

// OCPDB (MobiData BW) OCPI 2.2 Tariffs. Same element/price-component shape as
// the DOT-NL feed EXCEPT VAT is carried in a `taxes: [{name, percentage}]`
// array (not an inline `vat`), and tariffs join to stations by the `evse_id`
// stem of `original_id` (connector.tariff_ids is empty in this feed).
const SOURCE_ID = "de-ocpdb";

interface OcpdbTax {
  name?: string;
  percentage?: string | number;
}

interface OcpdbPriceComponent {
  type?: string;
  price?: number;
  taxes?: OcpdbTax[] | null;
  step_size?: number;
}

interface OcpdbRestrictions {
  start_time?: string | null;
  end_time?: string | null;
  min_power?: number | null;
  max_power?: number | null;
  // Charging-session duration bounds in SECONDS. EnBW's ad-hoc tariffs use
  // `min_duration` for a blocking fee that only applies past 2 h (a `0` here
  // means "unset", not "zero seconds").
  min_duration?: number | null;
  max_duration?: number | null;
}

interface OcpdbTariffElement {
  price_components?: OcpdbPriceComponent[];
  restrictions?: OcpdbRestrictions | null;
}

export interface OcpdbTariff {
  id?: string;
  original_id?: string;
  currency?: string;
  type?: string | null;
  elements?: OcpdbTariffElement[];
  last_updated?: string;
}

function mapType(type: string | undefined): EvTariffDimension | undefined {
  switch (type) {
    case "ENERGY":
      return "energy";
    case "TIME":
      return "time";
    case "FLAT":
      return "flat";
    case "PARKING_TIME":
      return "parking";
    default:
      // Stray/unmapped types (e.g. the top-level-only "REGULAR") are dropped.
      return undefined;
  }
}

function vatFromTaxes(taxes: OcpdbTax[] | null | undefined): number | undefined {
  for (const tax of taxes ?? []) {
    if ((tax.name ?? "").toUpperCase() === "VAT") {
      const pct = typeof tax.percentage === "number" ? tax.percentage : Number(tax.percentage);
      if (Number.isFinite(pct)) return pct;
    }
  }
  return undefined;
}

function mapComponents(
  components: OcpdbPriceComponent[] | undefined,
  currency: string,
): EvChargingPriceComponent[] {
  const out: EvChargingPriceComponent[] = [];
  for (const c of components ?? []) {
    const type = mapType(c.type);
    if (!type || typeof c.price !== "number") continue;
    out.push({
      type,
      price: c.price,
      currency,
      vat: vatFromTaxes(c.taxes),
      stepSize: typeof c.step_size === "number" ? c.step_size : undefined,
    });
  }
  return out;
}

function durationMinutes(seconds: number | null | undefined): number | undefined {
  // OCPDB uses 0 as "unset" for duration bounds, so treat only strictly
  // positive values as a real restriction.
  return typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 60) : undefined;
}

function mapRestrictions(
  r: OcpdbRestrictions | null | undefined,
): EvChargingTariffRestriction | undefined {
  if (!r) return undefined;
  const out: EvChargingTariffRestriction = {
    timeOfDayStart: cleanString(r.start_time ?? undefined),
    timeOfDayEnd: cleanString(r.end_time ?? undefined),
    minPowerKw: typeof r.min_power === "number" ? r.min_power : undefined,
    maxPowerKw: typeof r.max_power === "number" ? r.max_power : undefined,
    minDurationMinutes: durationMinutes(r.min_duration),
    maxDurationMinutes: durationMinutes(r.max_duration),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/**
 * Maps one OCPDB OCPI Tariff to one or more `EvChargingTariff`s, grouping the
 * price components by their element's restrictions. Unlike `mapNlDotnlTariff`
 * (which flattens first-element-wins because NL records are overwhelmingly
 * single-element), OCPDB's dominant shape is two elements — an unrestricted
 * ENERGY price plus a TIME blocking fee gated by `min_duration` — so flattening
 * would wrongly stamp the blocking-fee condition onto the energy row. Splitting
 * per distinct restriction keeps each condition on its own component. Returns
 * an empty array when no priceable component survives.
 */
export function mapOcpdbTariff(raw: OcpdbTariff): EvChargingTariff[] {
  const currency = cleanString(raw.currency);
  if (!currency) return [];

  const groups = new Map<
    string,
    { restrictions: EvChargingTariffRestriction | undefined; elements: EvChargingPriceComponent[] }
  >();
  for (const el of raw.elements ?? []) {
    const components = mapComponents(el.price_components, currency);
    if (components.length === 0) continue;
    const restrictions = mapRestrictions(el.restrictions);
    const key = JSON.stringify(restrictions ?? null);
    const group = groups.get(key);
    if (group) group.elements.push(...components);
    else groups.set(key, { restrictions, elements: components });
  }
  if (groups.size === 0) return [];

  const updatedAt = cleanString(raw.last_updated) ?? new Date().toISOString();
  const isDirectPayment = raw.type === "AD_HOC_PAYMENT" || undefined;
  return [...groups.values()].map((group) => ({
    elements: group.elements,
    restrictions: group.restrictions,
    scope: "cpo",
    isDirectPayment,
    source: SOURCE_ID,
    updatedAt,
  }));
}

export function tariffStemFromOriginalId(originalId: string): string {
  return originalId.split(":")[0];
}

/**
 * Builds an `evse_id → tariff[]` map from the OCPDB tariffs feed. The key is the
 * `original_id` stem (everything before the first `:`), which equals the
 * station's `evse.evse_id` (verified against real EnBW data). Multiple tariffs
 * can target one EVSE, so values accumulate.
 */
export function buildTariffMapByEvseId(rawTariffs: unknown): Map<string, EvChargingTariff[]> {
  const map = new Map<string, EvChargingTariff[]>();
  if (!Array.isArray(rawTariffs)) return map;
  for (const entry of rawTariffs) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as OcpdbTariff;
    const originalId = cleanString(raw.original_id);
    if (!originalId) continue;
    const tariffs = mapOcpdbTariff(raw);
    if (tariffs.length === 0) continue;
    const key = tariffStemFromOriginalId(originalId);
    const list = map.get(key);
    if (list) list.push(...tariffs);
    else map.set(key, [...tariffs]);
  }
  return map;
}
