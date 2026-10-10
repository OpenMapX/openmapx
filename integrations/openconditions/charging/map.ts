import type {
  ChargingConnector,
  ChargingSite,
  EnergyTariff,
  EnergyTariffRestrictions,
  Evse,
  EvseStatus,
} from "@openmapx/integration-framework";
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
  upstreamCredits,
} from "../features/record.js";

const EVSE_STATUSES: ReadonlySet<string> = new Set<EvseStatus>([
  "available",
  "charging",
  "occupied",
  "reserved",
  "blocked",
  "out_of_order",
  "inoperative",
  "planned",
  "removed",
  "unknown",
]);
const AUDIENCES: ReadonlySet<string> = new Set<NonNullable<ChargingSite["audience"]>>([
  "public",
  "customers",
  "permit",
  "private",
  "restricted",
  "unknown",
]);
const COMPONENT_TYPES: ReadonlySet<string> = new Set<
  EnergyTariff["elements"][number]["components"][number]["type"]
>(["energy", "time", "flat", "parking_time", "session", "idle", "reservation", "distance"]);
const WEEK_DAYS: ReadonlySet<string> = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const CLOSED_LIFECYCLES = new Set(["temporarily_closed", "decommissioned"]);

/** Seconds per UCUM duration unit. */
const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1,
  min: 60,
  h: 3_600,
  d: 86_400,
  wk: 604_800,
};

function oneOf<T extends string>(set: ReadonlySet<string>, value: unknown): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A money amount, which OpenConditions writes as a decimal string. */
function amountOf(money: unknown): number | undefined {
  const amount = Number(rec(money)["amount"]);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function secondsOf(quantity: unknown): number | undefined {
  const q = rec(quantity);
  const perUnit = typeof q["unit"] === "string" ? SECONDS_PER_UNIT[q["unit"]] : undefined;
  const value = q["value"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !perUnit) {
    return undefined;
  }
  return value * perUnit;
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];

function restrictionsOf(raw: unknown): EnergyTariffRestrictions | undefined {
  const r = rec(raw);
  const out: EnergyTariffRestrictions = {};
  for (const key of ["startTime", "endTime", "startDate", "endDate", "reservation"] as const) {
    const value = str(r[key]);
    if (value) out[key] = value;
  }
  const days = stringsOf(r["days"]).filter(
    (d): d is NonNullable<EnergyTariffRestrictions["days"]>[number] => WEEK_DAYS.has(d),
  );
  if (days.length > 0) out.days = days;
  for (const key of [
    "minKwh",
    "maxKwh",
    "minCurrentA",
    "maxCurrentA",
    "minPowerKw",
    "maxPowerKw",
  ] as const) {
    const value = number(r[key]);
    if (value !== undefined) out[key] = value;
  }
  const min = secondsOf(r["minDuration"]);
  const max = secondsOf(r["maxDuration"]);
  if (min !== undefined) out.minDurationSec = min;
  if (max !== undefined) out.maxDurationSec = max;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An `energy_tariff` offer as a tariff; undefined for another offer or one without a priced row. */
function tariffOf(offer: Rec): EnergyTariff | undefined {
  const id = str(offer["id"]);
  const currency = str(offer["currency"]);
  const sourceId = str(rec(offer["provenance"])["sourceId"]);
  if (offer["kind"] !== "energy_tariff" || !id || !currency || !sourceId) return undefined;
  const elements: EnergyTariff["elements"] = [];
  for (const element of list(offer["elements"])) {
    const components: EnergyTariff["elements"][number]["components"] = [];
    for (const component of list(element["components"])) {
      const type = oneOf<EnergyTariff["elements"][number]["components"][number]["type"]>(
        COMPONENT_TYPES,
        component["type"],
      );
      const price = amountOf(component["price"]);
      if (!type || price === undefined) continue;
      const vatPct = number(component["vatPct"]);
      const stepSize = number(component["stepSize"]);
      components.push({
        type,
        price,
        ...(vatPct !== undefined ? { vatPct } : {}),
        ...(stepSize !== undefined ? { stepSize } : {}),
      });
    }
    if (components.length === 0) continue;
    const restrictions = restrictionsOf(element["restrictions"]);
    elements.push({ components, ...(restrictions ? { restrictions } : {}) });
  }
  if (elements.length === 0) return undefined;
  const type = str(offer["tariffType"]);
  const minPrice = amountOf(offer["minPrice"]);
  const maxPrice = amountOf(offer["maxPrice"]);
  const altText = firstText(offer["altText"]) ?? firstText(offer["displayText"]);
  const url = str(offer["url"]);
  return {
    id,
    currency,
    ...(type ? { type } : {}),
    elements,
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(typeof offer["priceIncludesVat"] === "boolean"
      ? { priceIncludesVat: offer["priceIncludesVat"] }
      : {}),
    ...(altText ? { altText } : {}),
    ...(url ? { url } : {}),
    sourceId,
  };
}

interface Status {
  status?: EvseStatus;
  at?: string;
  stale: boolean;
  used: LatestReading[];
}

/** What the reading of `property` about one component says, and whether it has outlived its validity. */
function statusOf(
  readings: readonly LatestReading[],
  property: string,
  componentKey: string,
  now: Date,
): Status {
  const reading = newestReading(readings, property, componentKey);
  const status = oneOf<EvseStatus>(EVSE_STATUSES, rec(reading?.result)["value"]);
  if (!reading || status === undefined) return { stale: false, used: [] };
  const until = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
  const at = instantOf(reading.phenomenonTime);
  return {
    status,
    ...(at ? { at } : {}),
    stale: Number.isFinite(until) && until < now.getTime(),
    used: [reading],
  };
}

/**
 * An OpenConditions `charging_site` record with its readings in effect and its
 * live offers as a site. Every source `excluded` holds is taken out: its
 * credit, its readings (a fused reading with an excluded contributor too),
 * its tariffs and the charge points only it published. Crowd reports are the
 * instance's own and public: a reading they contributed to is kept and
 * credits them. Null when the record is not a placeable charging site, or
 * when its survivor is excluded: the name, address and operator are the
 * survivor's and cannot be told apart from it. A credit takes its source's
 * link and its licence name from `sources`. A reading past its `validUntil`
 * at `now` is stale.
 */
export function recordToChargingSite(
  record: Rec,
  latest: readonly LatestReading[],
  offers: readonly Rec[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CreditSources = NO_SOURCES,
  now: Date = new Date(),
): ChargingSite | null {
  const id = itemIdOf(record);
  const location = rec(record["location"]);
  const coordinates = pointOf(location);
  if (!id || record["kind"] !== "charging_site" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const prefixes = keyPrefixesOf(
    record,
    all.map((s) => s.id),
  );
  const readings = allowedReadings(latest, excluded);
  const components = list(record["components"]);
  const sourceOf = (key: string) => splitKey(key, prefixes).source ?? survivor.id;
  let crowd = false;

  const tariffs = offers
    .filter((offer) => {
      const sourceId = str(rec(offer["provenance"])["sourceId"]);
      return sourceId !== undefined && !excluded(sourceId);
    })
    .map(tariffOf)
    .filter((tariff): tariff is EnergyTariff => tariff !== undefined);
  const tariffIds = new Set(tariffs.map((t) => t.id));

  const evses: Evse[] = [];
  for (const component of components) {
    const key = str(component["key"]);
    if (component["kind"] !== "evse" || !key) continue;
    const details = rec(component["details"]);
    const quantity = number(details["quantity"]) ?? 1;
    const own =
      quantity > 1
        ? ({ stale: false, used: [] } as Status)
        : statusOf(readings, "charging.evse_status", key, now);

    const connectors: ChargingConnector[] = [];
    const used = [...own.used];
    for (const child of components) {
      const connectorKey = str(child["key"]);
      if (child["kind"] !== "connector" || !connectorKey || child["parentKey"] !== key) continue;
      const cDetails = rec(child["details"]);
      const standard = str(cDetails["standard"]);
      if (!standard) continue;
      const live = statusOf(readings, "charging.connector_status", connectorKey, now);
      if (excluded(sourceOf(connectorKey)) && live.used.length === 0) continue;
      used.push(...live.used);
      const format = oneOf<"socket" | "cable">(new Set(["socket", "cable"]), cDetails["format"]);
      const current = oneOf<"ac" | "dc">(new Set(["ac", "dc"]), cDetails["current"]);
      const powerType = str(cDetails["powerType"]);
      const maxPowerKw = number(cDetails["maxPowerKw"]);
      const maxVoltage = number(cDetails["maxVoltage"]);
      const maxAmperage = number(cDetails["maxAmperage"]);
      connectors.push({
        key: connectorKey,
        standard,
        ...(format ? { format } : {}),
        ...(powerType ? { powerType } : {}),
        ...(current ? { current } : {}),
        ...(maxPowerKw !== undefined ? { maxPowerKw } : {}),
        ...(maxVoltage !== undefined ? { maxVoltage } : {}),
        ...(maxAmperage !== undefined ? { maxAmperage } : {}),
        tariffIds: stringsOf(cDetails["tariffRefs"]).filter((ref) => tariffIds.has(ref)),
        ...(live.status ? { status: live.status } : {}),
        ...(live.at ? { statusAt: live.at } : {}),
        stale: live.stale,
      });
    }
    // A charge point only an excluded source published goes, unless a reading we may show is about it.
    if (excluded(sourceOf(key)) && used.length === 0) continue;
    if (used.some(crowdReported)) crowd = true;

    const evseId = str(details["evseId"]);
    const lifecycle = str(component["lifecycle"]);
    evses.push({
      key,
      ...(evseId ? { evseId } : {}),
      quantity,
      ...(lifecycle ? { lifecycle } : {}),
      ...(own.status ? { status: own.status } : {}),
      ...(own.at ? { statusAt: own.at } : {}),
      stale: own.stale,
      capabilities: stringsOf(details["capabilities"]),
      parkingRestrictions: stringsOf(details["parkingRestrictions"]),
      connectors,
    });
  }

  const details = rec(record["details"]);
  const access = rec(record["access"]);
  const lifecycle = String(record["lifecycle"]);
  const name = firstText(record["name"]);
  const country = countryOf(location);
  const address = addressOf(location) ?? str(rec(location["address"])["text"]);
  const operatorName = firstText(rec(record["operator"])["name"]);
  const operatorSite = str(rec(record["operator"])["website"]);
  const owner = firstText(rec(record["owner"])["name"]);
  const brand = str(details["brand"]);
  const website = str(details["website"]);
  const openingHours = rec(record["openingHours"]);
  const osmHours = str(openingHours["osm"]);
  const timeZone = str(openingHours["timezone"]);
  const openingHoursText = firstText(details["openingHoursText"]);
  const audience = oneOf<NonNullable<ChargingSite["audience"]>>(AUDIENCES, access["audience"]);
  const tariffText = firstText(details["tariffText"]);
  const notes = firstText(record["description"]);
  return {
    id,
    name: name ?? "",
    ...(country ? { country } : {}),
    coordinates,
    ...(timeZone ? { timeZone } : {}),
    ...(operatorName
      ? { operator: { name: operatorName, ...(operatorSite ? { website: operatorSite } : {}) } }
      : {}),
    ...(owner ? { owner } : {}),
    ...(brand ? { brand } : {}),
    ...(website ? { website } : {}),
    ...(address ? { address } : {}),
    ...(osmHours ? { openingHours: osmHours } : {}),
    ...(openingHoursText ? { openingHoursText } : {}),
    ...(audience ? { audience } : {}),
    payment: stringsOf(access["payment"]),
    authentication: stringsOf(access["authentication"]),
    closed: CLOSED_LIFECYCLES.has(lifecycle),
    planned: lifecycle === "planned",
    evses,
    tariffs,
    ...(tariffText ? { tariffText } : {}),
    ...(notes ? { notes } : {}),
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...(crowd ? [CROWD_CREDIT] : []),
    ],
  };
}
