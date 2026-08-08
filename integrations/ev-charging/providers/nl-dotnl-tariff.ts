import type { EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import {
  type OcpiPriceComponentLike,
  type OcpiRestrictionsLike,
  splitOcpiTariffElements,
} from "./ocpi-tariff.js";
import { cleanString } from "./utils.js";

// NDW/DOT-NL national open charging data — OCPI 2.2 Tariffs array. Element and
// restriction mapping is shared with de-ocpdb via ocpi-tariff.ts; NL differs
// only in carrying VAT inline (`vat`) and in resolving tariffs to stations by
// the connector `tariff_ids` → `id` join.
export const NL_DOTNL_TARIFFS_URL = "https://opendata.ndw.nu/charging_point_tariffs_ocpi.json.gz";

const SOURCE_ID = "nl-dotnl";

interface OcpiPriceComponent extends OcpiPriceComponentLike {
  vat?: number | null;
}

interface OcpiTariffElement {
  price_components?: OcpiPriceComponent[] | null;
  restrictions?: OcpiRestrictionsLike | null;
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

function vatOf(component: OcpiPriceComponent): number | undefined {
  return typeof component.vat === "number" ? component.vat : undefined;
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

/**
 * Maps one OCPI Tariff object to one or more `EvChargingTariff`s, splitting the
 * price components by their element's restrictions (see `splitOcpiTariffElements`).
 * NL tariffs are frequently multi-element with differing restrictions (a base
 * energy price plus a duration-gated parking/blocking fee), so splitting keeps
 * each condition on its own component instead of flat-stamping one across the
 * whole tariff. Returns an empty array when no priceable component survives.
 */
export function mapNlDotnlTariff(raw: OcpiTariff): EvChargingTariff[] {
  const currency = cleanString(raw.currency);
  if (!currency) return [];

  const groups = splitOcpiTariffElements(raw.elements, currency, vatOf);
  if (groups.length === 0) return [];

  const base = {
    scope: "cpo" as const,
    isDirectPayment: raw.type === "AD_HOC_PAYMENT" || undefined,
    source: SOURCE_ID,
    sourceUrl: cleanString(raw.tariff_alt_url ?? undefined),
    altText: pickAltText(raw.tariff_alt_text),
    updatedAt: cleanString(raw.last_updated) ?? new Date().toISOString(),
  };
  return groups.map((group) => ({
    elements: group.elements,
    restrictions: group.restrictions,
    ...base,
  }));
}

export function buildTariffMap(rawTariffs: unknown): Map<string, EvChargingTariff[]> {
  const map = new Map<string, EvChargingTariff[]>();
  if (!Array.isArray(rawTariffs)) return map;
  for (const entry of rawTariffs) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as OcpiTariff;
    const id = cleanString(raw.id);
    if (!id) continue;
    const tariffs = mapNlDotnlTariff(raw);
    if (tariffs.length > 0) map.set(id, tariffs);
  }
  return map;
}

export function parseNlDotnlTariffs(buffer: Buffer): Map<string, EvChargingTariff[]> {
  const parsed = JSON.parse(buffer.toString("utf-8")) as unknown;
  return buildTariffMap(parsed);
}

/**
 * Resolves one connector's `tariff_ids` (opaque exact-match strings — see the
 * NDW scout report §6) against the tariff map built from the tariffs feed. One
 * tariff id can map to several `EvChargingTariff`s (one per distinct
 * restriction), so matches are flattened. Deduping across a station's
 * connectors is the tariff collector's job, since it also has to fold in which
 * connectors resolved to each tariff.
 */
export function resolveTariffs(
  tariffIds: ReadonlyArray<string | null> | null | undefined,
  tariffMap: Map<string, EvChargingTariff[]>,
): EvChargingTariff[] {
  const out: EvChargingTariff[] = [];
  const seen = new Set<string>();
  for (const rawId of tariffIds ?? []) {
    const id = cleanString(rawId ?? undefined);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(...(tariffMap.get(id) ?? []));
  }
  return out;
}
