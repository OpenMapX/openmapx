import type { EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { FiPriceComponent, FiTariff, FiTariffElement } from "./fi-digitraffic-client.js";
import {
  type OcpiPriceComponentLike,
  type OcpiRestrictionsLike,
  type OcpiTariffElementLike,
  splitOcpiTariffElements,
} from "./ocpi-tariff.js";
import { cleanString, idString } from "./utils.js";

// Digitraffic's AFIR tariff shape carries the same element/restriction ideas
// as OCPI 2.2 (de-ocpdb, nl-dotnl) but serializes everything in camelCase
// (priceComponents, startTime/endTime, minDuration/maxDuration in SECONDS)
// instead of snake_case, and VAT is an inline `vat` percentage per price
// component (like nl-dotnl, not OCPDB's `taxes[]` array). Adapting field
// names onto the shared OcpiPriceComponentLike/OcpiRestrictionsLike shapes
// lets this reuse ocpi-tariff.ts's element/restriction-group splitting
// instead of duplicating it.
const SOURCE_ID = "fi-digitraffic";

interface FiOcpiPriceComponent extends OcpiPriceComponentLike {
  vat?: number;
}

function toOcpiElement(el: FiTariffElement): OcpiTariffElementLike<FiOcpiPriceComponent> {
  const priceComponents: FiOcpiPriceComponent[] = (el.priceComponents ?? []).map(
    (c: FiPriceComponent) => ({
      type: c.type,
      price: c.price,
      step_size: c.stepSize,
      vat: c.vat,
    }),
  );
  const r = el.restrictions;
  const restrictions: OcpiRestrictionsLike | undefined = r
    ? {
        start_time: r.startTime,
        end_time: r.endTime,
        min_duration: r.minDuration,
        max_duration: r.maxDuration,
      }
    : undefined;
  return { price_components: priceComponents, restrictions };
}

function vatOf(component: FiOcpiPriceComponent): number | undefined {
  return typeof component.vat === "number" ? component.vat : undefined;
}

/**
 * Maps one Digitraffic tariff to one or more `EvChargingTariff`s, splitting
 * the price components by their element's restrictions (see
 * `splitOcpiTariffElements`) — e.g. an unrestricted ENERGY price plus a
 * duration-gated PARKING_TIME fee stay on separate rows. Returns an empty
 * array when no priceable component survives (no currency, or every element
 * carries an unmapped type/missing price).
 */
export function mapFiTariff(raw: FiTariff): EvChargingTariff[] {
  const currency = cleanString(raw.currency);
  if (!currency) return [];

  const elements = (raw.elements ?? []).map(toOcpiElement);
  const groups = splitOcpiTariffElements(elements, currency, vatOf);
  if (groups.length === 0) return [];

  const updatedAt = cleanString(raw.lastUpdated) ?? new Date().toISOString();
  const isDirectPayment = raw.type === "AD_HOC_PAYMENT" || undefined;
  // Digitraffic's sample data leaves tariff_alt_text empty far more often than
  // it populates it, so — per spec — tariffAltUrl doubles as both the
  // clickable source link and the human-readable alt text until a richer
  // text field is confirmed to be populated in practice.
  const tariffAltUrl = cleanString(raw.tariffAltUrl);
  return groups.map((group) => ({
    elements: group.elements,
    restrictions: group.restrictions,
    scope: "evse",
    isDirectPayment,
    source: SOURCE_ID,
    updatedAt,
    sourceUrl: tariffAltUrl,
    altText: tariffAltUrl,
  }));
}

/** Builds a `tariff.id → tariff[]` map from the Digitraffic tariffs feed. */
export function buildFiTariffMapById(tariffs: FiTariff[]): Map<string, EvChargingTariff[]> {
  const map = new Map<string, EvChargingTariff[]>();
  for (const raw of tariffs) {
    const id = idString(raw.id);
    if (!id) continue;
    const mapped = mapFiTariff(raw);
    if (mapped.length > 0) map.set(id, mapped);
  }
  return map;
}
