import type { FuelProduct, FuelStation } from "@openmapx/integration-framework";

type Rec = Record<string, unknown>;
type Attribution = FuelStation["attributions"][number];

/** One latest reading of a feature as `expand=latest` serves it. */
export interface LatestReading {
  property: string;
  componentKey?: string;
  result: unknown;
  phenomenonTime: unknown;
  /**
   * A feed id, or for a reading fused from `contributors` `@fused` (every
   * source; all public in public scope) or `@fused-public` (the public sources
   * of a fusion that also used a non-public one).
   */
  source: string;
  contributors?: string[];
}

const FUSED = new Set(["@fused", "@fused-public"]);

/** The contributor id OpenConditions gives its own crowd reports. */
const CROWD = "crowd";

/**
 * The credit of the OpenConditions instance's community reports. They are no
 * feed, so `/sources` never lists them; they are public in every scope.
 */
export const CROWD_CREDIT: Attribution = {
  sourceId: CROWD,
  name: "OpenConditions community reports",
  url: "https://openconditions.org",
};
const UNITS = new Set(["L", "kg", "m3"]);

function rec(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function list(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

/** A source of the station and the credit it carries, survivor first. */
interface StationSource {
  id: string;
  attribution: Rec;
}

function sourcesOf(record: Rec): StationSource[] {
  const provenance = rec(record["provenance"]);
  const out: StationSource[] = [];
  const add = (id: unknown, attribution: unknown) => {
    const sourceId = str(id);
    if (sourceId && !out.some((s) => s.id === sourceId)) {
      out.push({ id: sourceId, attribution: rec(attribution) });
    }
  };
  add(provenance["sourceId"], provenance["attribution"]);
  for (const merged of list(provenance["mergedSources"])) {
    add(merged["source"], merged["attribution"]);
  }
  return out;
}

/** The ids of the records a canonical station was built from: its members and merged records. */
export function memberIdsOf(record: Rec): string[] {
  const provenance = rec(record["provenance"]);
  const ids = [
    ...list(rec(provenance["derivedFrom"])["records"]).map((r) => r["id"]),
    ...list(provenance["mergedSources"]).map((m) => m["recordId"]),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

/** The sources behind a reading: its own, or every contributor of a fused one. */
function readingSources(reading: LatestReading): string[] {
  return FUSED.has(reading.source) ? (reading.contributors ?? []) : [reading.source];
}

/** The feeds behind a reading, which must be listed and not excluded; crowd reports are none. */
function readingFeeds(reading: LatestReading): string[] {
  return readingSources(reading).filter((id) => id !== CROWD);
}

/** When a reading was observed, in epoch milliseconds; -Infinity when it does not say. */
function observedAt(reading: LatestReading): number {
  const at = instantOf(reading.phenomenonTime);
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** A source's link by source id, from the live data sources. */
export type SourceLink = (sourceId: string) => string | undefined;

const noLink: SourceLink = () => undefined;

/** A source's credit; without a link of its own it takes the source's link from `linkOf`. */
function credit(source: StationSource, linkOf: SourceLink): Attribution {
  const a = source.attribution;
  const url = str(a["url"]) ?? linkOf(source.id);
  const license = str(a["license"]);
  const licenseUrl = str(a["licenseUrl"]);
  return {
    sourceId: source.id,
    name: str(a["provider"]) ?? source.id,
    ...(url ? { url } : {}),
    ...(license ? { spdxLicense: license } : {}),
    ...(licenseUrl ? { licenseUrl } : {}),
  };
}

function addressOf(location: Rec): string | undefined {
  const address = rec(location["address"]);
  const street = [str(address["street"]), str(address["houseNumber"])].filter(Boolean).join(" ");
  const place = [str(address["postalCode"]), str(address["city"])].filter(Boolean).join(" ");
  const line = [street, place].filter(Boolean).join(", ");
  return line.length > 0 ? line : undefined;
}

function countryOf(location: Rec): string | undefined {
  const country =
    str(rec(location["address"])["country"]) ?? str(rec(location["admin"])["country"]);
  return country && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined;
}

function pointOf(location: Rec): [number, number] | undefined {
  const geometry = rec(location["geometry"]);
  const coordinates = geometry["coordinates"];
  if (geometry["type"] !== "Point" || !Array.isArray(coordinates)) return undefined;
  const [lon, lat] = coordinates;
  return typeof lon === "number" && typeof lat === "number" ? [lon, lat] : undefined;
}

function instantOf(time: unknown): string | undefined {
  const t = rec(time);
  return str(t["instant"]) ?? str(t["end"]) ?? str(t["start"]);
}

function priceOf(reading: LatestReading | undefined): FuelProduct["price"] | undefined {
  const result = rec(reading?.result);
  const amount = Number(result["amount"]);
  const currency = str(result["currency"]);
  if (result["type"] !== "money" || !Number.isFinite(amount) || !currency) return undefined;
  return { amount, currency };
}

/** A prefix a canonical component key may carry, and the source whose component it marks. */
interface KeyPrefix {
  prefix: string;
  source: string;
}

const FEATURE_ID = /^oc:feature:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(.+)$/;

/**
 * The prefixes a canonical station keys a merged member's own products
 * under: `<sourceId>/`, or `<localId>/` of the member record when another
 * component already took `<sourceId>/<key>`. A member's local id counts only
 * when the record's namespace is one of the station's sources.
 */
function keyPrefixesOf(record: Rec, sourceIds: readonly string[]): KeyPrefix[] {
  const locals = memberIdsOf(record).flatMap((memberId) => {
    const [, namespace, localId] = FEATURE_ID.exec(memberId) ?? [];
    return namespace && localId && sourceIds.includes(namespace)
      ? [{ prefix: localId, source: namespace }]
      : [];
  });
  return [...sourceIds.map((id) => ({ prefix: id, source: id })), ...locals];
}

/** The product key of a component key and the source it marks, when a prefix marks one. */
function splitKey(key: string, prefixes: readonly KeyPrefix[]): { source?: string; key: string } {
  const owner = prefixes.find(({ prefix }) => key.startsWith(`${prefix}/`));
  return owner ? { source: owner.source, key: key.slice(owner.prefix.length + 1) } : { key };
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
 * source's link from `linkOf`.
 */
export function recordToFuelStation(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  linkOf: SourceLink = noLink,
): FuelStation | null {
  const id = str(record["id"]);
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

  // A fused reading is one value OpenConditions computed from all its
  // contributors; the excluded source's share cannot be taken out of it, so
  // the whole reading goes, even when an allowed contributor agreed with it.
  // The product may then show no price where the allowed source alone had one.
  const readings = latest.filter((r) => !readingFeeds(r).some(excluded));
  // Where fusion has not run, OpenConditions serves each member's reading of
  // a component; the newest observation is the one in effect.
  const reading = (property: string, componentKey: string) =>
    readings
      .filter((r) => r.property === property && r.componentKey === componentKey)
      .reduce<LatestReading | undefined>(
        (newest, r) => (newest === undefined || observedAt(r) > observedAt(newest) ? r : newest),
        undefined,
      );

  const products: FuelProduct[] = [];
  let crowdReported = false;
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
    crowdReported ||= [priced, stocked].some((r) => r && readingSources(r).includes(CROWD));
  }

  const details = rec(record["details"]);
  const name = list(record["name"])
    .map((n) => str(n["text"]))
    .find(Boolean);
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
    attributions: [...kept.map((s) => credit(s, linkOf)), ...(crowdReported ? [CROWD_CREDIT] : [])],
  };
}
