import type { EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import {
  type OcpiPriceComponentLike,
  type OcpiRestrictionsLike,
  splitOcpiTariffElements,
} from "./ocpi-tariff.js";
import { cleanString } from "./utils.js";

// OCPDB (MobiData BW) OCPI 2.2 Tariffs. Element/restriction mapping is shared
// with nl-dotnl via ocpi-tariff.ts; OCPDB differs only in carrying VAT as a
// `taxes: [{name, percentage}]` array (not an inline `vat`), and in joining to
// stations by the `evse_id` stem of `original_id` (connector.tariff_ids is
// empty in this feed).
const SOURCE_ID = "de-ocpdb";

interface OcpdbTax {
  name?: string;
  percentage?: string | number;
}

interface OcpdbPriceComponent extends OcpiPriceComponentLike {
  taxes?: OcpdbTax[] | null;
}

interface OcpdbTariffElement {
  price_components?: OcpdbPriceComponent[] | null;
  restrictions?: OcpiRestrictionsLike | null;
}

export interface OcpdbTariff {
  id?: string;
  original_id?: string;
  currency?: string;
  type?: string | null;
  elements?: OcpdbTariffElement[];
  last_updated?: string;
}

function vatFromTaxes(component: OcpdbPriceComponent): number | undefined {
  for (const tax of component.taxes ?? []) {
    if ((tax.name ?? "").toUpperCase() === "VAT") {
      const pct = typeof tax.percentage === "number" ? tax.percentage : Number(tax.percentage);
      if (Number.isFinite(pct)) return pct;
    }
  }
  return undefined;
}

/**
 * Maps one OCPDB OCPI Tariff to one or more `EvChargingTariff`s, splitting the
 * price components by their element's restrictions (see `splitOcpiTariffElements`).
 * OCPDB's dominant shape is an unrestricted ENERGY price plus a TIME blocking
 * fee gated by `min_duration`, so splitting keeps the blocking-fee condition off
 * the energy row. Returns an empty array when no priceable component survives.
 */
export function mapOcpdbTariff(raw: OcpdbTariff): EvChargingTariff[] {
  const currency = cleanString(raw.currency);
  if (!currency) return [];

  const groups = splitOcpiTariffElements(raw.elements, currency, vatFromTaxes);
  if (groups.length === 0) return [];

  const updatedAt = cleanString(raw.last_updated) ?? new Date().toISOString();
  const isDirectPayment = raw.type === "AD_HOC_PAYMENT" || undefined;
  return groups.map((group) => ({
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
