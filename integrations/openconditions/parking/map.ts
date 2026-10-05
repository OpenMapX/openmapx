import type {
  ParkingArea,
  ParkingCounts,
  ParkingLayout,
  ParkingRate,
  ParkingSite,
  ParkingSiteType,
  ParkingStatus,
  ParkingTrend,
} from "@openmapx/integration-framework";
import { licenseUrlForSpdx } from "@openmapx/mobility-core/license";
import {
  type Attribution,
  addressOf,
  allowedReadings,
  CROWD_CREDIT,
  countryOf,
  credit,
  crowdReported,
  firstText,
  instantOf,
  itemIdOf,
  keyPrefixesOf,
  type LatestReading,
  list,
  newestReading,
  noLink,
  pointOf,
  type Rec,
  type RecordSource,
  rec,
  type SourceLink,
  sourcesOf,
  splitKey,
  str,
} from "../features/record.js";

const SITE_TYPES: ReadonlySet<string> = new Set<ParkingSiteType>([
  "off_street",
  "on_street",
  "park_and_ride",
  "truck_parking",
  "rest_area_parking",
]);
const LAYOUTS: ReadonlySet<string> = new Set<ParkingLayout>([
  "single_level",
  "multi_storey",
  "underground",
  "surface",
  "automated",
  "covered",
  "nested",
  "unknown",
]);
const STATUSES: ReadonlySet<string> = new Set<ParkingStatus>([
  "open",
  "closed",
  "full",
  "almost_full",
  "spaces_available",
  "closed_abnormally",
  "unknown",
]);
const TRENDS: ReadonlySet<string> = new Set<ParkingTrend>(["filling", "clearing", "steady"]);
const AUDIENCES: ReadonlySet<string> = new Set<NonNullable<ParkingSite["audience"]>>([
  "public",
  "customers",
  "permit",
  "private",
  "restricted",
  "unknown",
]);
const CLOSED_LIFECYCLES = new Set(["temporarily_closed", "decommissioned"]);

/**
 * Minutes per UCUM duration unit. A month and a year are the UCUM averages
 * (`mo` 30.4375 days, `a` 365.25 days), as the tariff rows are read back.
 */
const MINUTES_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1 / 60,
  min: 1,
  h: 60,
  d: 1_440,
  wk: 10_080,
  mo: 43_830,
  a: 525_960,
};

const CENTIMETRES_PER_UNIT: Readonly<Record<string, number>> = { m: 100, cm: 1 };

function oneOf<T extends string>(set: ReadonlySet<string>, value: unknown): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

/** A count a reading or record can mean: a whole number of zero or more. */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A Quantity of time in minutes; undefined for a unit or value that cannot be read. */
function minutesOf(quantity: unknown): number | undefined {
  const q = rec(quantity);
  const value = q["value"];
  const perUnit = typeof q["unit"] === "string" ? MINUTES_PER_UNIT[q["unit"]] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !perUnit) {
    return undefined;
  }
  return value * perUnit;
}

function heightLimitCmOf(details: Rec): number | undefined {
  const limit = rec(details["heightLimit"]);
  const value = limit["value"];
  const perUnit =
    typeof limit["unit"] === "string" ? CENTIMETRES_PER_UNIT[limit["unit"]] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !perUnit) {
    return undefined;
  }
  return Math.round(value * perUnit);
}

/**
 * The counts of the site (`componentKey` undefined) or one of its areas from
 * its readings in effect. The time is the newest reading's; the counts are
 * stale once any reading they come from is past its `validUntil`.
 */
function countsOf(
  readings: readonly LatestReading[],
  componentKey: string | undefined,
  now: Date,
): { counts: Omit<ParkingCounts, "capacity">; used: LatestReading[] } {
  const available = newestReading(readings, "parking.available", componentKey);
  const status = newestReading(readings, "parking.status", componentKey);
  const trend = newestReading(readings, "parking.trend", componentKey);
  const free = countOf(rec(available?.result)["value"]);
  const statusValue = oneOf<ParkingStatus>(STATUSES, rec(status?.result)["value"]);
  const trendValue = oneOf<ParkingTrend>(TRENDS, rec(trend?.result)["value"]);
  const used = [
    ...(free !== undefined ? [available!] : []),
    ...(statusValue !== undefined ? [status!] : []),
    ...(trendValue !== undefined ? [trend!] : []),
  ];
  const times = used
    .map((r) => instantOf(r.phenomenonTime))
    .filter((t): t is string => t !== undefined && Number.isFinite(Date.parse(t)));
  const at = times.reduce<string | undefined>(
    (newest, t) => (newest === undefined || Date.parse(t) > Date.parse(newest) ? t : newest),
    undefined,
  );
  const stale = used.some((r) => {
    const until = r.validUntil === undefined ? Number.NaN : Date.parse(r.validUntil);
    return Number.isFinite(until) && until < now.getTime();
  });
  return {
    counts: {
      ...(free !== undefined ? { available: free } : {}),
      ...(statusValue ? { status: statusValue } : {}),
      ...(trendValue ? { trend: trendValue } : {}),
      ...(at ? { at } : {}),
      stale,
    },
    used,
  };
}

/** A `parking_rate` offer as a rate; undefined for another offer or one without a priced row. */
function rateOf(offer: Rec): ParkingRate | undefined {
  if (offer["kind"] !== "parking_rate") return undefined;
  const rows: ParkingRate["rows"] = [];
  let currency = str(offer["currency"]);
  for (const element of list(offer["elements"])) {
    const restrictions = rec(element["restrictions"]);
    const fromMin = minutesOf(restrictions["minDuration"]);
    const toMin = minutesOf(restrictions["maxDuration"]);
    const userGroups = Array.isArray(restrictions["userGroups"])
      ? restrictions["userGroups"].filter((g): g is string => typeof g === "string" && g !== "")
      : [];
    for (const component of list(element["components"])) {
      const type = component["type"];
      const price = rec(component["price"]);
      const amount = Number(price["amount"]);
      if ((type !== "flat" && type !== "parking_time") || !Number.isFinite(amount) || amount < 0) {
        continue;
      }
      currency ??= str(price["currency"]);
      const step = component["stepSize"];
      const stepMin =
        type === "parking_time" && typeof step === "number" && step > 0 ? step / 60 : undefined;
      rows.push({
        kind: type === "flat" ? "flat" : "per_hour",
        amount,
        ...(fromMin !== undefined ? { fromMin } : {}),
        ...(toMin !== undefined ? { toMin } : {}),
        ...(stepMin !== undefined ? { stepMin } : {}),
        ...(userGroups.length > 0 ? { userGroups } : {}),
      });
    }
  }
  if (rows.length === 0 || currency === undefined) return undefined;
  const text = firstText(offer["displayText"]);
  return { currency, rows, ...(text ? { text } : {}) };
}

/**
 * The credits of the upstream publishers the aggregators among the kept
 * sources took the site from: one per publisher with a licence, named
 * "<feed provider> – <publisher>" under the feed it came through, with the
 * licence's own text linked.
 */
function upstreamCredits(kept: readonly RecordSource[], linkOf: SourceLink): Attribution[] {
  const out: Attribution[] = [];
  for (const source of kept) {
    const feed = credit(source, linkOf);
    for (const u of source.upstream) {
      const publisher = str(u["publisher"]);
      const license = str(u["license"]);
      if (!publisher || !license) continue;
      const name = `${feed.name} – ${publisher}`;
      if (out.some((a) => a.sourceId === source.id && a.name === name)) continue;
      const licenseUrl = licenseUrlForSpdx(license);
      out.push({
        sourceId: source.id,
        name,
        ...(feed.url ? { url: feed.url } : {}),
        spdxLicense: license,
        ...(licenseUrl ? { licenseUrl } : {}),
        publisher: { name: publisher },
      });
    }
  }
  return out;
}

/** Whether an area says more than that the site has such spaces. */
const counted = (area: ParkingArea) =>
  area.capacity !== undefined ||
  area.available !== undefined ||
  area.status !== undefined ||
  area.trend !== undefined;

/**
 * An OpenConditions `parking_site` record with its readings in effect and its
 * live offers as a site. Every source `excluded` holds is taken out: its
 * credit, its readings (a fused reading with an excluded contributor too),
 * its offers and the areas only it published. Crowd reports are the
 * instance's own and public: a reading they contributed to is kept and
 * credits them. Null when the record is not a placeable parking site, or when
 * its survivor is excluded: the name, address and counts are the survivor's
 * and cannot be told apart from it. A credit the record carries without a
 * link takes its source's link from `linkOf`. A reading past its `validUntil`
 * at `now` is stale.
 */
export function recordToParkingSite(
  record: Rec,
  latest: readonly LatestReading[],
  offers: readonly Rec[],
  excluded: (sourceId: string) => boolean = () => false,
  linkOf: SourceLink = noLink,
  now: Date = new Date(),
): ParkingSite | null {
  const id = itemIdOf(record);
  const location = rec(record["location"]);
  const coordinates = pointOf(location);
  if (!id || record["kind"] !== "parking_site" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const prefixes = keyPrefixesOf(
    record,
    all.map((s) => s.id),
  );
  const readings = allowedReadings(latest, excluded);
  const site = countsOf(readings, undefined, now);
  let crowd = site.used.some(crowdReported);

  const areas: ParkingArea[] = [];
  for (const component of list(record["components"])) {
    const rawKey = str(component["key"]);
    const details = rec(component["details"]);
    const vehicleType = str(details["vehicleType"]);
    const userGroup = str(details["userGroup"]) ?? "any";
    if (component["kind"] !== "parking_area" || !rawKey || !vehicleType) continue;
    const { source = survivor.id } = splitKey(rawKey, prefixes);
    const own = countsOf(readings, rawKey, now);
    if (excluded(source) && own.used.length === 0) continue;
    const capacity = countOf(details["capacity"]);
    const area: ParkingArea = {
      key: `${vehicleType}:${userGroup}`,
      vehicleType,
      userGroup,
      ...(capacity !== undefined ? { capacity } : {}),
      ...own.counts,
    };
    const held = areas.findIndex((a) => a.key === area.key);
    // Two areas under one key are one area: a counted one replaces one that only says it exists.
    if (held === -1) areas.push(area);
    else if (!counted(areas[held]!) && counted(area)) areas[held] = area;
    else continue;
    crowd ||= own.used.some(crowdReported);
  }

  const rates = offers
    .filter((offer) => {
      const sourceId = str(rec(offer["provenance"])["sourceId"]);
      return sourceId !== undefined && !excluded(sourceId);
    })
    .map(rateOf)
    .filter((rate): rate is ParkingRate => rate !== undefined);

  const details = rec(record["details"]);
  const access = rec(record["access"]);
  const payment = Array.isArray(access["payment"]) ? access["payment"] : [];
  const name = firstText(record["name"]);
  const type = oneOf<ParkingSiteType>(SITE_TYPES, record["type"]);
  const layout = oneOf<ParkingLayout>(LAYOUTS, details["layout"]);
  const capacity = countOf(details["capacityTotal"]);
  const country = countryOf(location);
  const address = addressOf(location) ?? str(rec(location["address"])["text"]);
  const operator = firstText(rec(record["operator"])["name"]);
  const website = str(details["website"]);
  const openingHours = str(rec(record["openingHours"])["osm"]);
  const openingHoursText = firstText(details["openingHoursText"]);
  const audience = oneOf<NonNullable<ParkingSite["audience"]>>(AUDIENCES, access["audience"]);
  const heightLimitCm = heightLimitCmOf(details);
  const tariffText = firstText(details["tariffText"]);
  const notes = firstText(record["description"]);
  return {
    id,
    name: name ?? "",
    ...(country ? { country } : {}),
    coordinates,
    ...(type ? { type } : {}),
    ...(layout ? { layout } : {}),
    closed: CLOSED_LIFECYCLES.has(String(record["lifecycle"])),
    ...(operator ? { operator } : {}),
    ...(website ? { website } : {}),
    ...(address ? { address } : {}),
    ...(openingHours ? { openingHours } : {}),
    ...(openingHoursText ? { openingHoursText } : {}),
    ...(audience ? { audience } : {}),
    ...(payment.length > 0 ? { free: payment.includes("free") } : {}),
    ...(heightLimitCm !== undefined ? { heightLimitCm } : {}),
    ...(capacity !== undefined ? { capacity } : {}),
    ...site.counts,
    areas,
    rates,
    ...(tariffText ? { tariffText } : {}),
    ...(notes ? { notes } : {}),
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, linkOf)),
      ...upstreamCredits(kept, linkOf),
      ...(crowd ? [CROWD_CREDIT] : []),
    ],
  };
}
