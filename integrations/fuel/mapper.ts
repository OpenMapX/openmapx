import { resolveBrandByName } from "@openmapx/brands";
import {
  type DataSourceAttribution,
  type DataSourceBranding,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  gapFillBranding,
  isSafeHttpUrl,
  type OsmIdentity,
  validObservedAt,
} from "@openmapx/core";
import { parseOpeningHours } from "@openmapx/core/server";
import {
  type I18nToken,
  money,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type { FuelProduct, FuelStation } from "@openmapx/mobility-core/fuel";
import strings from "./strings/en.json" with { type: "json" };

/** The grades the result card leads with, in display order; any other grade follows. */
const SUMMARY_GRADES = ["diesel", "e5", "e10", "sp98", "e85", "lpg"];

/** Every grade `summary.grade.<grade>` has a label for; any other is shown by its code. */
const LABELLED_GRADES = new Set(Object.keys(strings.summary.grade));

const UNIT_LABEL: Record<FuelProduct["per"], string> = { L: "L", kg: "kg", m3: "m³" };

type PricedProduct = FuelProduct & { price: NonNullable<FuelProduct["price"]> };

function isPriced(product: FuelProduct): product is PricedProduct {
  return product.available !== false && product.price !== undefined;
}

/** The currency of the station's first priced product; prices in another are not compared. */
function stationCurrency(station: FuelStation): string | undefined {
  return station.products.find(isPriced)?.price.currency;
}

/**
 * Each grade's lowest per-litre price among its self-service or standard
 * products. Served-pump prices, lorry-only pumps and per-kg/m³ grades are left
 * out: a sort by price must compare what a driver pays at the pump they work
 * themselves.
 */
function buildSortValues(
  station: FuelStation,
  currency: string | undefined,
): Record<string, number> | undefined {
  const values: Record<string, number> = {};
  for (const product of station.products) {
    if (!isPriced(product) || product.per !== "L" || product.service === "served") continue;
    if (product.vehicleScope === "hgv") continue;
    if (product.price.currency !== currency) continue;
    const current = values[product.grade];
    if (current === undefined || product.price.amount < current) {
      values[product.grade] = product.price.amount;
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/** The oldest report time among the priced products: the result is no fresher than that. */
function oldestPriceAt(station: FuelStation): string | undefined {
  let oldest: string | undefined;
  for (const product of station.products) {
    if (!isPriced(product)) continue;
    const at = validObservedAt(product.priceAt);
    if (at && (oldest === undefined || Date.parse(at) < Date.parse(oldest))) oldest = at;
  }
  return oldest === undefined ? undefined : new Date(oldest).toISOString();
}

/** One price the result card shows: a grade's, for cars or lorries, in its unit. */
interface SummaryPrice {
  grade: string;
  hgv: boolean;
  per: FuelProduct["per"];
  served: boolean;
  amount: number;
}

/** A grade's short label on the card: translated, or for an unknown grade its code. */
function summaryLabel(grade: string): I18nToken | string {
  return LABELLED_GRADES.has(grade)
    ? token(`summary.grade.${grade}`)
    : grade.replaceAll("_", " ").toUpperCase();
}

/** Where a grade sorts on the card: the summary grades in their order, then the rest. */
function summaryRank(grade: string): number {
  const index = SUMMARY_GRADES.indexOf(grade);
  return index === -1 ? SUMMARY_GRADES.length : index;
}

/**
 * The card's price summary: every priced grade in the station's currency,
 * so any station with a price shows one. A grade shows its lowest
 * self-service or standard price, else its lowest served one; a per-kg or
 * per-m³ price carries its unit; a lorry-only price shows only for a grade
 * no car pump prices.
 */
function formatPriceSummary(
  station: FuelStation,
  currency: string | undefined,
): I18nToken | undefined {
  if (!currency) return undefined;
  const best = new Map<string, SummaryPrice>();
  for (const product of station.products) {
    if (!isPriced(product) || product.price.currency !== currency) continue;
    const price: SummaryPrice = {
      grade: product.grade,
      hgv: product.vehicleScope === "hgv",
      per: product.per,
      served: product.service === "served",
      amount: product.price.amount,
    };
    const key = `${price.grade}|${price.hgv}|${price.per}`;
    const held = best.get(key);
    const better =
      held === undefined ||
      (held.served && !price.served) ||
      (held.served === price.served && price.amount < held.amount);
    if (better) best.set(key, price);
  }
  const prices = [...best.values()];
  const shown = prices
    .filter((p) => !p.hgv || !prices.some((o) => !o.hgv && o.grade === p.grade))
    .sort((a, b) => summaryRank(a.grade) - summaryRank(b.grade));
  if (shown.length === 0) return undefined;
  const part = (p: SummaryPrice): I18nToken =>
    token("summary.price", {
      label: summaryLabel(p.grade),
      // A price per litre needs no unit on the card.
      amount: p.per === "L" ? fuelMoney(p.amount, currency) : pricePer(p.amount, currency, p.per),
    });
  const car = joinParts(shown.filter((p) => !p.hgv).map(part));
  const hgv = joinParts(shown.filter((p) => p.hgv).map(part));
  const scope = car ? (hgv ? "both" : "car") : "hgv";
  return token("summary.priceList", { prices: car ?? "", hgvPrices: hgv ?? "", scope });
}

/** The parts as one token, each after the last, so any count reads as a list. */
function joinParts(parts: I18nToken[]): I18nToken | undefined {
  let joined: I18nToken | undefined;
  for (const part of parts.toReversed()) {
    joined = joined ? token("summary.join", { head: part, tail: joined }) : part;
  }
  return joined;
}

function openVariant(station: FuelStation): string {
  const [lon, lat] = station.coordinates;
  const status = parseOpeningHours(station.openingHours, {
    lat,
    lon,
    countryCode: station.country?.toLowerCase(),
  });
  if (!status || status.isUnknown) return "unknown";
  return status.isOpen ? "open" : "closed";
}

/**
 * The brand's catalogued logo, gap-filled from a plain-name match. Feeds
 * publish a brand name and no Wikidata identity, so the match is exact and
 * scoped to fuel stations in the station's country; an ambiguous name gives
 * no logo rather than a wrong one.
 */
function stationBranding(station: FuelStation): DataSourceBranding | undefined {
  const brand = station.brand;
  if (!brand) return undefined;
  const entry = resolveBrandByName(brand, { tagSet: "amenity=fuel", country: station.country });
  return gapFillBranding(undefined, undefined, () => entry);
}

/**
 * The station's credits as per-record attributions. The `fuel` manifest
 * declares no sources of its own — every credit comes from the providers — so
 * each result and detail carries the credits of the sources it was built from.
 * Their links come from upstream data, so only http(s) ones are kept.
 */
function stationCredits(station: FuelStation): DataSourceAttribution[] | undefined {
  if (station.attributions.length === 0) return undefined;
  return station.attributions.map((a) => ({
    text: a.name,
    url: isSafeHttpUrl(a.url) ? a.url : "",
    ...(a.spdxLicense ? { license: a.spdxLicense } : {}),
    ...(isSafeHttpUrl(a.licenseUrl) ? { licenseUrl: a.licenseUrl } : {}),
  }));
}

/** A station's title when its sources name it nothing, not even by its brand. */
function fallbackNameOf(station: FuelStation): { fallbackName?: I18nToken } {
  return station.name ? {} : { fallbackName: token("stationFallbackName") };
}

function stationIdentity(station: FuelStation): OsmIdentity | undefined {
  if (!station.brand) return undefined;
  return { brand: station.brand, operator: station.brand };
}

export function mapFuelStationToResult(station: FuelStation): DataSourceResult {
  const currency = stationCurrency(station);
  const sortValues = buildSortValues(station, currency);
  const variant = openVariant(station);
  const summary = formatPriceSummary(station, currency);
  const result: DataSourceResult = {
    id: station.id,
    name: station.name,
    ...fallbackNameOf(station),
    coordinates: station.coordinates,
    source: station.sources[0] ?? "unknown",
    sources: station.sources,
    variant,
    status: variant,
    summary,
    operator: station.brand,
    sortValues,
    observedAt: oldestPriceAt(station),
    currency: summary ? currency : undefined,
  };
  const attributions = stationCredits(station);
  if (attributions) result.attributions = attributions;
  const branding = stationBranding(station);
  if (branding) result.branding = branding;
  return result;
}

function priceCell(product: FuelProduct): Translatable {
  if (product.available === false) return token("product.notSold");
  if (!product.price) return token("product.noPrice");
  return pricePer(product.price.amount, product.price.currency, product.per);
}

/** A price with its unit ("€1.799/L"); the client formats the amount in the reader's locale. */
function pricePer(amount: number, currency: string, per: FuelProduct["per"]): I18nToken {
  return token("price.per", { price: fuelMoney(amount, currency), unit: UNIT_LABEL[per] });
}

/** Fuel is priced to tenths of a cent ("€1.790"), so three digits always show. */
function fuelMoney(amount: number, currency: string): I18nToken {
  return money(amount, currency, 3);
}

/** The caption under a product: its service level and when its price was reported. */
function productCaption(product: FuelProduct): Translatable {
  const priceAt = product.available === false ? undefined : validObservedAt(product.priceAt);
  const at = priceAt ? Date.parse(priceAt) : undefined;
  if (product.service && at !== undefined) {
    return token("product.servicePriceAt", { service: product.service, at });
  }
  if (product.service) return token("product.service", { service: product.service });
  if (at !== undefined) return token("product.priceAt", { at });
  return "";
}

/** One row per product, each with its own price time; a product not sold says so. */
function buildProductTable(station: FuelStation): DataSourceDetailSection | null {
  if (station.products.length === 0) return null;
  return {
    title: token("section.fuelPrices"),
    type: "table",
    columns: [token("column.fuelType"), token("column.price")],
    rows: station.products.map((product) => [
      product.vehicleScope === "hgv"
        ? token("fuelHgv", { grade: token(`fuel.${product.grade}`) })
        : token(`fuel.${product.grade}`),
      priceCell(product),
      productCaption(product),
    ]),
    rowLayout: "pricing",
    sectionIcon: "fuel",
  };
}

export function mapFuelStationToDetail(station: FuelStation): DataSourceDetail {
  const table = buildProductTable(station);
  const detail: DataSourceDetail = {
    id: station.id,
    sources: station.sources,
    name: station.name,
    ...fallbackNameOf(station),
    coordinates: station.coordinates,
    identity: stationIdentity(station),
    address: station.address ? { line1: station.address } : undefined,
    operator: station.brand ? { name: station.brand } : undefined,
    openingHours: station.openingHours,
    sections: table ? [table] : [],
  };
  const attributions = stationCredits(station);
  if (attributions) detail.attributions = attributions;
  const branding = stationBranding(station);
  if (branding) detail.branding = branding;
  return detail;
}
