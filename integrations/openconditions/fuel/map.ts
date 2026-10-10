import type { FuelProduct, FuelStation } from "@openmapx/integration-framework";
import {
  addressOf,
  allowedReadings,
  CROWD_CREDIT,
  type CreditSources,
  countryOf,
  credit,
  crowdReported,
  firstText,
  instantOf,
  itemIdOf,
  keyPrefixesOf,
  type LatestReading,
  list,
  NO_SOURCES,
  newestReading,
  pointOf,
  type Rec,
  rec,
  sourcesOf,
  splitKey,
  str,
} from "../features/record.js";

const UNITS = new Set(["L", "kg", "m3"]);

function priceOf(reading: LatestReading | undefined): FuelProduct["price"] | undefined {
  const result = rec(reading?.result);
  const amount = Number(result["amount"]);
  const currency = str(result["currency"]);
  if (result["type"] !== "money" || !Number.isFinite(amount) || !currency) return undefined;
  return { amount, currency };
}

/**
 * Whether a product is one a station posts at the pump: a standard, gross
 * price. Member, card, fleet and cash prices and net prices are left out; no
 * fuel source publishes them today, and `FuelProduct` has no field to tell
 * them apart from the posted price.
 */
function postedProduct(details: Rec): boolean {
  const level = details["priceLevel"];
  return (
    (level === undefined || level === "standard" || level === "unknown") &&
    details["priceBasis"] !== "net"
  );
}

/** A product for lorries only (OSM's `hgv_diesel`), or undefined for one any vehicle may buy. */
function lorryOnly(details: Rec): "hgv" | undefined {
  return details["vehicleScope"] === "hgv" ? "hgv" : undefined;
}

/**
 * An OpenConditions `fuel_station` record with its latest readings as a
 * station. Every source `excluded` holds is taken out: its credit, its
 * readings (a fused reading with an excluded contributor too) and the products
 * only it published. Crowd reports are the instance's own and public: a
 * reading they contributed to is kept and credits them. Null when the record
 * is not a placeable fuel station, or when the record's survivor is excluded:
 * the name, brand, address and opening hours are the survivor's and cannot be
 * told apart from it. A credit the record carries without a link takes its
 * source's link from `sources`, and its licence name from there too.
 */
export function recordToFuelStation(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CreditSources = NO_SOURCES,
): FuelStation | null {
  const id = itemIdOf(record);
  const location = rec(record["location"]);
  const coordinates = pointOf(location);
  if (!id || record["kind"] !== "fuel_station" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0]?.id;
  if (survivor === undefined || excluded(survivor)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const prefixes = keyPrefixesOf(
    record,
    all.map((s) => s.id),
  );

  // The product may show no price where the allowed source alone had one: a
  // fused reading with an excluded contributor goes as a whole.
  const readings = allowedReadings(latest, excluded);
  const reading = (property: string, componentKey: string) =>
    newestReading(readings, property, componentKey);

  const products: FuelProduct[] = [];
  let crowd = false;
  for (const component of list(record["components"])) {
    const rawKey = str(component["key"]);
    const details = rec(component["details"]);
    const grade = str(details["grade"]);
    const per = details["per"];
    if (component["kind"] !== "fuel_product" || !rawKey || !grade) continue;
    if (typeof per !== "string" || !UNITS.has(per) || !postedProduct(details)) continue;
    const { source = survivor, key } = splitKey(rawKey, prefixes);
    const vehicleScope = lorryOnly(details);
    const held = products.findIndex((p) => p.key === key);
    // Two products under one key are one product: a priced one replaces an unpriced one.
    if (held !== -1 && products[held]!.price !== undefined) continue;
    const priced = reading("fuel.price", rawKey);
    const stocked = reading("fuel.product_available", rawKey);
    if (excluded(source) && priced === undefined && stocked === undefined) continue;
    const price = priceOf(priced);
    if (held !== -1 && price === undefined) continue;
    const priceAt = price ? instantOf(priced?.phenomenonTime) : undefined;
    const inStock = rec(stocked?.result)["value"];
    const service = details["service"];
    const product: FuelProduct = {
      key,
      grade,
      ...(service === "self" || service === "served" ? { service } : {}),
      ...(vehicleScope ? { vehicleScope } : {}),
      per: per as FuelProduct["per"],
      ...(price ? { price } : {}),
      ...(priceAt ? { priceAt } : {}),
      // An explicit stock-out outweighs a price still on record.
      available: inStock === false ? false : price || inStock === true ? true : "unknown",
    };
    if (held === -1) products.push(product);
    else products[held] = product;
    crowd ||= crowdReported(priced) || crowdReported(stocked);
  }

  const details = rec(record["details"]);
  const name = firstText(record["name"]);
  const brand = str(details["brand"]);
  const country = countryOf(location);
  const address = addressOf(location);
  const openingHours = str(rec(record["openingHours"])["osm"]);
  return {
    id,
    name: name ?? brand ?? "",
    ...(brand ? { brand } : {}),
    ...(country ? { country } : {}),
    coordinates,
    ...(address ? { address } : {}),
    ...(openingHours ? { openingHours } : {}),
    products,
    productsComplete: details["productsComplete"] === true,
    sources: kept.map((s) => s.id),
    attributions: [...kept.map((s) => credit(s, sources)), ...(crowd ? [CROWD_CREDIT] : [])],
  };
}
