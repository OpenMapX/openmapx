import type {
  EvChargingPriceComponent,
  EvChargingTariff,
  EvChargingTariffRestriction,
  EvTariffDimension,
} from "@openmapx/mobility-core/ev-charging";
import { cleanString } from "./utils.js";

// NDW/DOT-NL national open charging data — OCPI 2.2 Tariffs array.
export const DOTNL_TARIFFS_URL = "https://opendata.ndw.nu/charging_point_tariffs_ocpi.json.gz";

const SOURCE_ID = "netherlands-ev";

interface OcpiPriceComponent {
  type?: string;
  price?: number;
  vat?: number | null;
  step_size?: number;
}

interface OcpiRestrictions {
  start_time?: string | null;
  end_time?: string | null;
  min_power?: number | null;
  max_power?: number | null;
}

interface OcpiTariffElement {
  price_components?: OcpiPriceComponent[];
  restrictions?: OcpiRestrictions | null;
}

interface OcpiDisplayText {
  language?: string;
  text?: string;
}

interface OcpiTariff {
  id?: string;
  currency?: string;
  type?: string | null;
  tariff_alt_text?: OcpiDisplayText[] | null;
  tariff_alt_url?: string | null;
  elements?: OcpiTariffElement[];
  last_updated?: string;
}

function mapPriceComponentType(type: string | undefined): EvTariffDimension | undefined {
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
      // Stray/unmapped types (e.g. the top-level-only "REGULAR") are dropped
      // rather than emitted with `type: undefined`.
      return undefined;
  }
}

function mapPriceComponents(
  components: OcpiPriceComponent[] | undefined,
  currency: string,
): EvChargingPriceComponent[] {
  const out: EvChargingPriceComponent[] = [];
  for (const component of components ?? []) {
    const type = mapPriceComponentType(component.type);
    if (!type || typeof component.price !== "number") continue;
    out.push({
      type,
      price: component.price,
      currency,
      vat: typeof component.vat === "number" ? component.vat : undefined,
      stepSize: typeof component.step_size === "number" ? component.step_size : undefined,
    });
  }
  return out;
}

/**
 * Picks a single display string from an OCPI `DisplayText[]` (`tariff_alt_text`):
 * prefers `language === "en"`, falls back to `"nl"`, then the first entry
 * that has non-empty text. Returns undefined for an empty/absent array or
 * when every entry's text is blank.
 */
function pickAltText(entries: OcpiDisplayText[] | null | undefined): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const byLanguage = (language: string) =>
    entries.find((entry) => entry.language === language && cleanString(entry.text));
  const preferred =
    byLanguage("en") ?? byLanguage("nl") ?? entries.find((entry) => cleanString(entry.text));
  return preferred ? cleanString(preferred.text) : undefined;
}

function mapRestrictions(
  restrictions: OcpiRestrictions | null | undefined,
): EvChargingTariffRestriction | undefined {
  if (!restrictions) return undefined;
  const out: EvChargingTariffRestriction = {
    timeOfDayStart: cleanString(restrictions.start_time ?? undefined),
    timeOfDayEnd: cleanString(restrictions.end_time ?? undefined),
    minPowerKw: typeof restrictions.min_power === "number" ? restrictions.min_power : undefined,
    maxPowerKw: typeof restrictions.max_power === "number" ? restrictions.max_power : undefined,
  };
  return Object.values(out).some((value) => value !== undefined) ? out : undefined;
}

/**
 * Maps one OCPI Tariff object to an `EvChargingTariff`.
 *
 * `EvChargingTariff.restrictions` is a single (optional) object, but an OCPI
 * tariff can carry multiple `elements`, each with its own restrictions. Real
 * DOT-NL records overwhelmingly have exactly one element (confirmed in the
 * scout report), so this flattens every element's price_components into one
 * `elements` array and takes `restrictions` from the first element that has
 * any — the simpler of the two options the build brief allows, at the cost
 * of losing per-element restrictions on the rare multi-element tariff.
 */
export function mapDotNlTariff(raw: OcpiTariff): EvChargingTariff | null {
  const currency = cleanString(raw.currency);
  if (!currency) return null;

  const elements: EvChargingPriceComponent[] = [];
  let restrictions: EvChargingTariffRestriction | undefined;
  for (const element of raw.elements ?? []) {
    elements.push(...mapPriceComponents(element.price_components, currency));
    if (!restrictions) restrictions = mapRestrictions(element.restrictions);
  }
  if (elements.length === 0) return null;

  return {
    elements,
    restrictions,
    scope: "cpo",
    isDirectPayment: raw.type === "AD_HOC_PAYMENT" || undefined,
    source: SOURCE_ID,
    sourceUrl: cleanString(raw.tariff_alt_url ?? undefined),
    altText: pickAltText(raw.tariff_alt_text),
    updatedAt: cleanString(raw.last_updated) ?? new Date().toISOString(),
  };
}

export function buildTariffMap(rawTariffs: unknown): Map<string, EvChargingTariff> {
  const map = new Map<string, EvChargingTariff>();
  if (!Array.isArray(rawTariffs)) return map;
  for (const entry of rawTariffs) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as OcpiTariff;
    const id = cleanString(raw.id);
    if (!id) continue;
    const tariff = mapDotNlTariff(raw);
    if (tariff) map.set(id, tariff);
  }
  return map;
}

export function parseDotNlTariffs(buffer: Buffer): Map<string, EvChargingTariff> {
  const parsed = JSON.parse(buffer.toString("utf-8")) as unknown;
  return buildTariffMap(parsed);
}

/**
 * Resolves a station's collected `connector.tariff_ids` (deduped, opaque
 * exact-match strings — see the NDW scout report §6) against the tariff map
 * built from the tariffs feed.
 */
export function attachTariffs(
  tariffIds: readonly string[] | undefined,
  tariffMap: Map<string, EvChargingTariff>,
): EvChargingTariff[] | undefined {
  if (!tariffIds || tariffIds.length === 0) return undefined;
  const seen = new Set<string>();
  const out: EvChargingTariff[] = [];
  for (const id of tariffIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const tariff = tariffMap.get(id);
    if (tariff) out.push(tariff);
  }
  return out.length > 0 ? out : undefined;
}
