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
} from "@openmapx/core";
import {
  type I18nToken,
  money,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type {
  ParkingArea,
  ParkingRate,
  ParkingSite,
  ParkingSiteType,
  ParkingStatus,
  ParkingTrend,
} from "@openmapx/mobility-core/parking";
import strings from "./strings/en.json" with { type: "json" };

type Row = [I18nToken, Translatable];
type RateRow = ParkingRate["rows"][number];

/** Every vehicle type and user group the strings label; any other is shown as it is written. */
const LABELLED_VEHICLE_TYPES = new Set(Object.keys(strings.vehicleType));
const LABELLED_USER_GROUPS = new Set(Object.keys(strings.userGroup));

/** What a site is, for the types that say more than "off-street". */
const TYPE_TOKEN: Partial<Record<ParkingSiteType, I18nToken>> = {
  on_street: token("value.onStreet"),
  park_and_ride: token("value.parkAndRide"),
  truck_parking: token("value.truckParking"),
  rest_area_parking: token("value.restArea"),
};

const LAYOUT_TOKEN: Partial<Record<NonNullable<ParkingSite["layout"]>, I18nToken>> = {
  single_level: token("value.singleLevel"),
  multi_storey: token("value.parkingGarage"),
  underground: token("value.undergroundGarage"),
  surface: token("value.surfaceLot"),
  automated: token("value.automated"),
  covered: token("value.covered"),
  nested: token("value.nested"),
};

const STATUS_TOKEN: Partial<Record<ParkingStatus, I18nToken>> = {
  open: sharedT.value.open,
  closed: sharedT.value.closed,
  closed_abnormally: sharedT.value.closed,
  full: token("value.full"),
  almost_full: token("value.almostFull"),
  spaces_available: token("value.spacesAvailable"),
};

/** A steady trend is left out: only a site filling up or emptying is worth a row. */
const TREND_TOKEN: Partial<Record<ParkingTrend, I18nToken>> = {
  filling: token("value.trendIncreasing"),
  clearing: token("value.trendDecreasing"),
};

const AUDIENCE_TOKEN: Partial<Record<NonNullable<ParkingSite["audience"]>, I18nToken>> = {
  customers: sharedT.value.customers,
  permit: sharedT.value.permit,
  private: sharedT.value.private,
  restricted: token("value.restricted"),
};

/** The labels the old place panel used for the spaces most sites set aside for cars. */
const CAR_GROUP_ROW: Readonly<Record<string, string>> = {
  disabled: "row.disabledSpaces",
  women: "row.womenSpaces",
  ev_charging: "row.evCharging",
};

function isClosed(site: ParkingSite): boolean {
  return site.closed || site.status === "closed" || site.status === "closed_abnormally";
}

/** A fresh count of free spaces; a stale one is no count to go by. */
function freshAvailable(site: ParkingSite): number | undefined {
  return site.stale ? undefined : site.available;
}

/**
 * The marker colour. A closed site is closed whatever it counts; a stale
 * reading is unknown, never available. A status says full or almost full
 * without a count; a count of at most a fifth of the capacity is limited.
 */
function variantOf(site: ParkingSite): string {
  if (isClosed(site)) return "closed";
  if (site.stale) return "unknown";
  const { available, capacity, status } = site;
  if (status === "full" || available === 0) return "full";
  if (status === "almost_full") return "limited";
  if (available === undefined) return status === "spaces_available" ? "available" : "unknown";
  if (capacity && available <= capacity * 0.2) return "limited";
  return "available";
}

/** What the site is: its type when that says more than "off-street", else its layout. */
function kindToken(site: ParkingSite): I18nToken | undefined {
  return (site.type && TYPE_TOKEN[site.type]) ?? (site.layout && LAYOUT_TOKEN[site.layout]);
}

function summaryOf(site: ParkingSite): I18nToken | undefined {
  if (isClosed(site)) return token("summary.closed");
  if (site.stale) return token("summary.stale");
  const { available, capacity, status } = site;
  if (status === "full" || available === 0) return token("summary.full");
  if (available !== undefined) {
    return capacity
      ? token("summary.spacesOf", { free: available, capacity })
      : token("summary.spaces", { count: available });
  }
  if (status === "almost_full" || status === "spaces_available") return STATUS_TOKEN[status];
  if (capacity) return token("summary.totalSpaces", { count: capacity });
  return kindToken(site);
}

/**
 * The operator's catalogued logo, gap-filled from a plain-name match. Feeds
 * publish an operator name and no Wikidata identity, so the match is exact
 * and scoped to car parks in the site's country; an ambiguous name gives no
 * logo rather than a wrong one.
 */
function siteBranding(site: ParkingSite): DataSourceBranding | undefined {
  const operator = site.operator;
  if (!operator) return undefined;
  const entry = resolveBrandByName(operator, { tagSet: "amenity=parking", country: site.country });
  return gapFillBranding(undefined, undefined, () => entry);
}

/**
 * The site's credits as per-record attributions. The `parking` manifest
 * declares no sources of its own — every credit comes from the providers — so
 * each result and detail carries the credits of the sources it was built from.
 * Their links come from upstream data, so only http(s) ones are kept.
 */
function siteCredits(site: ParkingSite): DataSourceAttribution[] | undefined {
  if (site.attributions.length === 0) return undefined;
  return site.attributions.map((a) => ({
    text: a.name,
    url: isSafeHttpUrl(a.url) ? a.url : "",
    ...(a.spdxLicense ? { license: a.spdxLicense } : {}),
    ...(isSafeHttpUrl(a.licenseUrl) ? { licenseUrl: a.licenseUrl } : {}),
  }));
}

/** A site's title when its sources name it nothing. */
function fallbackNameOf(site: ParkingSite): { fallbackName?: I18nToken } {
  return site.name ? {} : { fallbackName: token("siteFallbackName") };
}

function siteIdentity(site: ParkingSite): OsmIdentity | undefined {
  return site.operator ? { operator: site.operator } : undefined;
}

export function mapParkingSiteToResult(site: ParkingSite): DataSourceResult {
  const available = freshAvailable(site);
  const result: DataSourceResult = {
    id: site.id,
    name: site.name,
    ...fallbackNameOf(site),
    coordinates: site.coordinates,
    source: site.sources[0] ?? "unknown",
    sources: site.sources,
    variant: variantOf(site),
    status: isClosed(site) ? "non-operational" : undefined,
    summary: summaryOf(site),
    operator: site.operator,
    sortValues: available === undefined ? undefined : { freeSpaces: available },
  };
  const attributions = siteCredits(site);
  if (attributions) result.attributions = attributions;
  const branding = siteBranding(site);
  if (branding) result.branding = branding;
  return result;
}

function formatTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

/** A count against its capacity, as the place panel shows it. */
function countOf(available: number, capacity: number | undefined): string {
  return capacity ? `${available} / ${capacity}` : `${available}`;
}

function vehicleTypeToken(vehicleType: string): I18nToken {
  return LABELLED_VEHICLE_TYPES.has(vehicleType)
    ? token(`vehicleType.${vehicleType}`)
    : token("literal", { value: vehicleType.replaceAll("_", " ") });
}

function userGroupToken(userGroup: string): I18nToken {
  return LABELLED_USER_GROUPS.has(userGroup)
    ? token(`userGroup.${userGroup}`)
    : token("literal", { value: userGroup.replaceAll("_", " ") });
}

/** An area's row label: its vehicles for untyped spaces, its user group for cars, else both. */
function areaLabel(area: ParkingArea): I18nToken {
  if (area.userGroup === "any") return vehicleTypeToken(area.vehicleType);
  if (area.vehicleType === "car" || area.vehicleType === "any") {
    const row = CAR_GROUP_ROW[area.userGroup];
    return row ? token(row) : userGroupToken(area.userGroup);
  }
  return token("area.forVehicle", {
    group: userGroupToken(area.userGroup),
    vehicle: vehicleTypeToken(area.vehicleType),
  });
}

/** The untyped car spaces of a site that counts nothing else: the site's own counts again. */
function repeatsSite(area: ParkingArea, site: ParkingSite): boolean {
  return (
    area.userGroup === "any" &&
    (area.vehicleType === "car" || area.vehicleType === "any") &&
    area.capacity === site.capacity &&
    area.available === site.available
  );
}

/** Areas with a fresh count go to availability; the rest show their capacity, or that they exist. */
function areaRows(site: ParkingSite): { live: Row[]; facility: Row[] } {
  const live: Row[] = [];
  const facility: Row[] = [];
  for (const area of site.areas) {
    if (repeatsSite(area, site)) continue;
    const label = areaLabel(area);
    if (area.available !== undefined && !area.stale) {
      live.push([label, countOf(area.available, area.capacity)]);
    } else if (area.capacity !== undefined) {
      facility.push([label, `${area.capacity}`]);
    } else {
      facility.push([label, token("value.available")]);
    }
  }
  return { live, facility };
}

function availabilitySection(site: ParkingSite, areaLive: Row[]): DataSourceDetailSection | null {
  const rows: Row[] = [];
  const { available, capacity } = site;
  if (available !== undefined) {
    rows.push([token("row.freeSpaces"), countOf(available, capacity)]);
    if (capacity) {
      // A live free count can exceed the static capacity; the share stays within 0–100%.
      const share = Math.round(((capacity - available) / capacity) * 100);
      const occupancy = Math.min(100, Math.max(0, share));
      rows.push([token("row.occupancy"), `${occupancy}%`]);
    }
  }
  const status = isClosed(site) ? sharedT.value.closed : site.status && STATUS_TOKEN[site.status];
  if (status) rows.push([sharedT.row.status, status]);
  const trend = site.trend && TREND_TOKEN[site.trend];
  if (trend) rows.push([token("row.trend"), trend]);
  if (site.stale) rows.push([token("row.dataFreshness"), sharedT.value.stale]);
  const updatedAt = formatTimestamp(site.at);
  if (updatedAt) rows.push([sharedT.row.lastUpdated, updatedAt]);
  rows.push(...areaLive);
  if (rows.length === 0) return null;
  return { title: token("section.availability"), type: "table", rows, sectionIcon: "info" };
}

function facilitySection(site: ParkingSite, areaFacility: Row[]): DataSourceDetailSection | null {
  const rows: Row[] = [];
  const type = site.type && TYPE_TOKEN[site.type];
  if (type) rows.push([sharedT.row.type, type]);
  const layout = site.layout && LAYOUT_TOKEN[site.layout];
  if (layout) rows.push([token("row.layout"), layout]);
  if (site.capacity) rows.push([sharedT.row.capacity, `${site.capacity}`]);
  if (site.heightLimitCm) {
    rows.push([token("row.maxHeight"), `${(site.heightLimitCm / 100).toFixed(2)} m`]);
  }
  rows.push(...areaFacility);
  const audience = site.audience && AUDIENCE_TOKEN[site.audience];
  if (audience) rows.push([sharedT.row.access, audience]);
  if (rows.length === 0) return null;
  return { title: token("section.facility"), type: "table", rows, sectionIcon: "info" };
}

const MINUTES = { hour: 60, day: 1_440, week: 10_080, month: 43_830, year: 525_960 };

/** `count` whole units of `per` minutes, allowing a day's slack per unit for calendar months and years. */
function wholeUnits(minutes: number, per: number): number | undefined {
  const count = Math.round(minutes / per);
  return count >= 1 && Math.abs(minutes - count * per) <= count * MINUTES.day ? count : undefined;
}

/**
 * A duration in its largest whole unit. A month or a year arrives in minutes
 * of whatever length its source counted (30 days, an average month, 365
 * days), so those units allow a day's slack per unit.
 */
function durationToken(minutes: number): I18nToken {
  const years = wholeUnits(minutes, MINUTES.year);
  if (years !== undefined) return token("tariff.durYears", { count: years });
  const months = wholeUnits(minutes, MINUTES.month);
  if (months !== undefined && months < 12) return token("tariff.durMonths", { count: months });
  const whole = Math.round(minutes);
  if (whole % MINUTES.week === 0) return token("tariff.durWeeks", { count: whole / MINUTES.week });
  if (whole % MINUTES.day === 0) return token("tariff.durDays", { count: whole / MINUTES.day });
  if (whole % MINUTES.hour === 0) return token("tariff.durHours", { count: whole / MINUTES.hour });
  return token("tariff.durMinutes", { count: whole });
}

/** The parts as one token, each after the last, so any count reads as a list. */
function joinParts(parts: I18nToken[]): I18nToken | undefined {
  let joined: I18nToken | undefined;
  for (const part of parts.toReversed()) {
    joined = joined ? token("tariff.join", { head: part, tail: joined }) : part;
  }
  return joined;
}

/** For how long a row applies, else what kind of price it is; then for whom, when not everyone. */
function rateLabel(row: RateRow): I18nToken {
  const from = row.fromMin ? durationToken(row.fromMin) : undefined;
  const to = row.toMin ? durationToken(row.toMin) : undefined;
  const span =
    from && to
      ? token("tariff.between", { from, to })
      : to
        ? token("tariff.upTo", { duration: to })
        : from
          ? token("tariff.from", { duration: from })
          : token(row.kind === "flat" ? "tariff.flat" : "tariff.hourly");
  const group = joinParts((row.userGroups ?? []).map(userGroupToken));
  return group ? token("tariff.forUserGroup", { label: span, group }) : span;
}

function rateValue(row: RateRow, currency: string): Translatable {
  const price = money(row.amount, currency);
  if (row.kind === "flat") return price;
  // Billed by the hour, a price per hour needs no step.
  return row.stepMin && row.stepMin !== 60
    ? token("tariff.perHourEvery", { price, step: durationToken(row.stepMin) })
    : token("tariff.perHour", { price });
}

/** One row per rate row; without any, the tariff in words, else whether parking is free. */
function pricingSection(site: ParkingSite): DataSourceDetailSection | null {
  const base = { title: sharedT.section.pricing, sectionIcon: "payments" } as const;
  const rows: Row[] = site.rates.flatMap((rate) =>
    rate.rows.map((row): Row => [rateLabel(row), rateValue(row, rate.currency)]),
  );
  const texts = [...new Set([site.tariffText, ...site.rates.map((r) => r.text)])].filter(
    (t): t is string => Boolean(t),
  );
  if (rows.length > 0) {
    return {
      ...base,
      type: "table",
      rows,
      ...(texts.length > 0 ? { caption: texts.join(" · ") } : {}),
    };
  }
  if (texts.length > 0) return { ...base, type: "text", content: texts.join(" · ") };
  if (site.free === true) return { ...base, type: "text", content: token("value.freeParking") };
  if (site.free === false) return { ...base, type: "text", content: token("value.paidParking") };
  return null;
}

export function mapParkingSiteToDetail(site: ParkingSite): DataSourceDetail {
  const areas = areaRows(site);
  const sections: DataSourceDetailSection[] = [];
  const availability = availabilitySection(site, areas.live);
  if (availability) sections.push(availability);
  const facility = facilitySection(site, areas.facility);
  if (facility) sections.push(facility);
  const pricing = pricingSection(site);
  if (pricing) sections.push(pricing);
  if (!site.openingHours && site.openingHoursText) {
    sections.push({
      title: token("section.openingHours"),
      type: "text",
      content: site.openingHoursText,
      sectionIcon: "access_time",
    });
  }
  if (site.notes) {
    sections.push({
      title: sharedT.section.notes,
      type: "text",
      content: site.notes,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  const detail: DataSourceDetail = {
    id: site.id,
    sources: site.sources,
    name: site.name,
    ...fallbackNameOf(site),
    coordinates: site.coordinates,
    identity: siteIdentity(site),
    address: site.address ? { line1: site.address } : undefined,
    operator: site.operator
      ? {
          name: site.operator,
          ...(isSafeHttpUrl(site.website) ? { url: site.website } : {}),
        }
      : undefined,
    openingHours: site.openingHours,
    sections,
    parkAndRide: site.type === "park_and_ride" ? true : undefined,
  };
  const attributions = siteCredits(site);
  if (attributions) detail.attributions = attributions;
  const branding = siteBranding(site);
  if (branding) detail.branding = branding;
  return detail;
}
