import type {
  EvChargingPriceComponent,
  EvChargingTariff,
  EvTariffDimension,
} from "@openmapx/mobility-core/ev-charging";
import { cleanString, parseLocalizedNumber } from "./utils.js";

const SOURCE_ID = "pl-eipa";
const SOURCE_URL = "https://eipa.udt.gov.pl";

export interface EipaPrice {
  price?: string | number;
  unit?: string;
  literal?: string;
  ts?: string;
}

function unitToDimension(unit: string | undefined): EvTariffDimension | undefined {
  switch ((unit ?? "").toLowerCase()) {
    case "kwh":
      return "energy";
    case "min":
      return "time";
    default:
      // "m3" (CNG/LNG) and anything else isn't an EV-charging price.
      return undefined;
  }
}

/**
 * Maps one point's `dynamic.json` `prices[]` array to a single
 * `EvChargingTariff` in PLN. EIPA emits one price row per unit — a station
 * can carry a per-kWh energy price and a per-minute price simultaneously,
 * each independently timestamped — so every priced unit becomes its own
 * `EvChargingPriceComponent` within one flat tariff; EIPA has no
 * restriction/session-condition structure to split components on, unlike
 * OCPI (see ocpi-tariff.ts). Returns `undefined` when no component maps to a
 * priceable EV dimension (e.g. a gas-only point, whose prices are all
 * `unit: "m3"`).
 */
export function mapEipaDynamicPrices(
  prices: EipaPrice[] | null | undefined,
): EvChargingTariff | undefined {
  if (!Array.isArray(prices) || prices.length === 0) return undefined;

  const elements: EvChargingPriceComponent[] = [];
  const altTexts: string[] = [];
  let newestTs: string | undefined;

  for (const p of prices) {
    const dimension = unitToDimension(p.unit);
    const price = parseLocalizedNumber(p.price);
    if (!dimension || price === undefined) continue;

    elements.push({ type: dimension, price, currency: "PLN" });

    const literal = cleanString(p.literal);
    if (literal && !altTexts.includes(literal)) altTexts.push(literal);

    const ts = cleanString(p.ts);
    if (ts && (!newestTs || Date.parse(ts) > Date.parse(newestTs))) newestTs = ts;
  }

  if (elements.length === 0) return undefined;

  return {
    elements,
    scope: "evse",
    source: SOURCE_ID,
    sourceUrl: SOURCE_URL,
    altText: altTexts.length > 0 ? altTexts.join("; ") : undefined,
    updatedAt: newestTs ?? new Date().toISOString(),
  };
}
