import type { EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import {
  type OcpiPriceComponentLike,
  type OcpiRestrictionsLike,
  splitOcpiTariffElements,
} from "./ocpi-tariff.js";
import { cleanString, idString } from "./utils.js";

// OCPDB (MobiData BW) OCPI 2.2 Tariffs. Element/restriction mapping is shared
// with nl-dotnl via ocpi-tariff.ts; OCPDB differs only in carrying VAT as a
// `taxes: [{name, percentage}]` array (not an inline `vat`). Tariffs join to
// stations via the OCPI 3.0 tariff-associations endpoint: evse_uid → tariff_id
// → this by-id map (connector.tariff_ids is empty in the OCPI 2.2 feed).
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

/** Builds a `tariff.id → tariff[]` map from the OCPDB tariffs feed. */
export function buildTariffMapById(rawTariffs: unknown): Map<string, EvChargingTariff[]> {
  const map = new Map<string, EvChargingTariff[]>();
  if (!Array.isArray(rawTariffs)) return map;
  for (const entry of rawTariffs) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as OcpdbTariff;
    const id = idString(raw.id);
    if (!id) continue;
    const tariffs = mapOcpdbTariff(raw);
    if (tariffs.length > 0) map.set(id, tariffs);
  }
  return map;
}

interface OcpdbAssociation {
  tariff_id?: string | number;
  evses?: Array<{ evse_uid?: string | number }> | null;
}

/**
 * Builds an `evse_uid → tariff_id set` map from the OCPI 3.0 tariff-associations
 * feed. Rows with no `evses` (or no `tariff_id`) are skipped; one evse_uid can
 * appear on several associations, so tariff ids accumulate.
 */
export function buildEvseUidToTariffIds(rawAssociations: unknown): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!Array.isArray(rawAssociations)) return map;
  for (const entry of rawAssociations) {
    if (!entry || typeof entry !== "object") continue;
    const assoc = entry as OcpdbAssociation;
    const tariffId = idString(assoc.tariff_id);
    if (!tariffId || !Array.isArray(assoc.evses)) continue;
    for (const evse of assoc.evses) {
      const uid = idString(evse?.evse_uid);
      if (!uid) continue;
      const set = map.get(uid);
      if (set) set.add(tariffId);
      else map.set(uid, new Set([tariffId]));
    }
  }
  return map;
}
