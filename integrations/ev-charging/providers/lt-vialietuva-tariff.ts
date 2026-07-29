import type { EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { LtTariff, LtTariffElement } from "./lt-vialietuva-client.js";
import {
  type OcpiPriceComponentLike,
  type OcpiTariffElementLike,
  splitOcpiTariffElements,
} from "./ocpi-tariff.js";
import { cleanString, idString } from "./utils.js";

// Via Lietuva OCPI 2.3 Tariffs. Element/restriction mapping is shared with
// nl-dotnl/de-ocpdb via ocpi-tariff.ts; LT differs from both in serializing
// `price` and `vat` as STRINGS ("0.3000", "21.0000") rather than numbers, so
// components are parsed to numbers here (parseElement) before delegating to
// the shared splitOcpiTariffElements. Tariffs join to stations via the
// connector `tariff_ids` → `id` join (see lt-vialietuva-parser.ts), so scope
// is "evse" rather than the "cpo"/tariff-wide scope nl-dotnl/de-ocpdb use.
const SOURCE_ID = "lt-vialietuva";

interface ParsedPriceComponent extends OcpiPriceComponentLike {
  vat?: number;
}

function numOf(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseElement(el: LtTariffElement): OcpiTariffElementLike<ParsedPriceComponent> {
  const components = (el.price_components ?? [])
    .map((c): ParsedPriceComponent | undefined => {
      const price = numOf(c.price);
      if (price === undefined) return undefined;
      return {
        type: c.type,
        price,
        step_size: typeof c.step_size === "number" ? c.step_size : undefined,
        vat: numOf(c.vat),
      };
    })
    .filter((c): c is ParsedPriceComponent => c !== undefined);
  return { price_components: components, restrictions: el.restrictions };
}

function vatOf(component: ParsedPriceComponent): number | undefined {
  return component.vat;
}

/**
 * Picks a single display string from an OCPI `DisplayText[]` (`tariff_alt_text`):
 * prefers `language === "en"`, otherwise the first entry with non-empty text.
 * Returns undefined for an empty/absent array or when every entry is blank.
 */
function pickAltText(entries: LtTariff["tariff_alt_text"]): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const preferred =
    entries.find((entry) => entry.language === "en" && cleanString(entry.text)) ??
    entries.find((entry) => cleanString(entry.text));
  return preferred ? cleanString(preferred.text) : undefined;
}

/**
 * Maps one Via Lietuva OCPI Tariff to one or more `EvChargingTariff`s,
 * splitting price components by their element's restrictions (see
 * `splitOcpiTariffElements`). Returns an empty array when no priceable
 * component survives (e.g. a tariff with only null/unparseable prices).
 */
export function mapLtVialietuvaTariff(raw: LtTariff): EvChargingTariff[] {
  const currency = cleanString(raw.currency);
  if (!currency) return [];

  const elements = (raw.elements ?? []).map(parseElement);
  const groups = splitOcpiTariffElements(elements, currency, vatOf);
  if (groups.length === 0) return [];

  const base = {
    scope: "evse" as const,
    source: SOURCE_ID,
    altText: pickAltText(raw.tariff_alt_text),
    updatedAt: cleanString(raw.last_updated) ?? new Date().toISOString(),
  };
  return groups.map((group) => ({
    elements: group.elements,
    restrictions: group.restrictions,
    ...base,
  }));
}

/** Builds a `tariff.id → tariff[]` map from the Via Lietuva tariffs feed. */
export function buildLtTariffMapById(
  tariffs: readonly LtTariff[],
): Map<string, EvChargingTariff[]> {
  const map = new Map<string, EvChargingTariff[]>();
  for (const raw of tariffs) {
    const id = idString(raw.id);
    if (!id) continue;
    const mapped = mapLtVialietuvaTariff(raw);
    if (mapped.length > 0) map.set(id, mapped);
  }
  return map;
}
