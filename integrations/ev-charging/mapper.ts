import { resolveBrandByName } from "@openmapx/brands";
import {
  type DataSourceAttribution,
  type DataSourceBranding,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  formatPaymentMethods,
  gapFillBranding,
  isSafeHttpUrl,
  type OsmIdentity,
  validObservedAt,
} from "@openmapx/core";
import {
  type I18nToken,
  money,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import {
  availabilityOf,
  type ChargingConnector,
  type ChargingSite,
  type EnergyTariff,
  type EnergyTariffRestrictions,
  type EvseStatus,
  freshEvseStatus,
} from "@openmapx/mobility-core/ev-charging";
import strings from "./strings/en.json" with { type: "json" };

type Row = [I18nToken, Translatable];
type Component = EnergyTariff["elements"][number]["components"][number];
type Day = NonNullable<EnergyTariffRestrictions["days"]>[number];

/** Every connector standard the strings label; any other is shown as it is written. */
const LABELLED_STANDARDS = new Set(Object.keys(strings.connector));

const WEEK: readonly Day[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** A charge point that is there and works, whether or not a vehicle is at it. */
const USABLE: ReadonlySet<EvseStatus> = new Set([
  "available",
  "charging",
  "occupied",
  "reserved",
  "blocked",
]);
const OUT_OF_SERVICE: ReadonlySet<EvseStatus> = new Set(["out_of_order", "inoperative"]);

/** The order connector rows of one standard and power are listed in; a row without a status comes last. */
const STATUS_ORDER: readonly EvseStatus[] = [
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
];

/** How the place panel colours a connector row's status. */
type StatusKind = "available" | "busy" | "out" | "planned" | "unknown";

const STATUS_KIND: Readonly<Record<EvseStatus, StatusKind>> = {
  available: "available",
  charging: "busy",
  occupied: "busy",
  reserved: "busy",
  blocked: "busy",
  out_of_order: "out",
  inoperative: "out",
  removed: "out",
  planned: "planned",
  unknown: "unknown",
};

const AUDIENCE_TOKEN: Partial<Record<NonNullable<ChargingSite["audience"]>, I18nToken>> = {
  public: sharedT.value.public,
  customers: sharedT.value.customers,
  permit: sharedT.value.permit,
  private: sharedT.value.private,
  restricted: token("value.restricted"),
};

function connectors(site: ChargingSite): { connector: ChargingConnector; quantity: number }[] {
  return site.evses.flatMap((evse) =>
    evse.connectors.map((connector) => ({ connector, quantity: evse.quantity })),
  );
}

function maxPowerOf(site: ChargingSite): number {
  let max = 0;
  for (const { connector } of connectors(site)) {
    if (connector.maxPowerKw && connector.maxPowerKw > max) max = connector.maxPowerKw;
  }
  return max;
}

/** The marker colour, by the fastest connector. */
function variantOf(site: ChargingSite): string {
  const max = maxPowerOf(site);
  if (max === 0) return "unknown";
  if (max <= 22) return "slow";
  if (max <= 100) return "fast";
  return "ultra-rapid";
}

/**
 * Whether a site is out of service: closed, or every charge point a fresh
 * reading speaks for is out of order or inoperative. A stale reading says
 * nothing either way.
 */
export function outOfService(site: ChargingSite): boolean {
  if (site.closed) return true;
  const known = site.evses.flatMap((evse) => freshEvseStatus(evse)?.status ?? []);
  return known.length > 0 && known.every((status) => OUT_OF_SERVICE.has(status));
}

/** The site's state as the map shows it; only a fresh reading makes it operational. */
function statusOf(site: ChargingSite): string {
  if (outOfService(site)) return "non-operational";
  if (site.planned) return "planned";
  const usable = site.evses.some((evse) => {
    const status = freshEvseStatus(evse)?.status;
    return status !== undefined && USABLE.has(status);
  });
  return usable ? "operational" : "unknown";
}

function standardToken(standard: string): I18nToken {
  return LABELLED_STANDARDS.has(standard)
    ? token(`connector.${standard}`)
    : token("literal", { value: standard.replaceAll("_", " ") });
}

/** The parts as one token, each after the last, so any count reads as a list. */
function joinParts(parts: Translatable[], key = "join"): Translatable | undefined {
  let joined: Translatable | undefined;
  for (const part of parts.toReversed()) {
    joined = joined === undefined ? part : token(key, { head: part, tail: joined });
  }
  return joined;
}

function summaryOf(site: ChargingSite): I18nToken | undefined {
  const all = connectors(site);
  const count = all.reduce((sum, c) => sum + c.quantity, 0);
  const standards = [...new Set(all.map((c) => c.connector.standard))].filter(
    (s) => s !== "UNKNOWN",
  );
  const types = joinParts(standards.map(standardToken));
  const power = maxPowerOf(site);
  if (count > 0 && types !== undefined) {
    return power > 0
      ? token("summary.connectorsTypedPower", { count, types, power })
      : token("summary.connectorsTyped", { count, types });
  }
  if (count > 0) {
    return power > 0
      ? token("summary.connectorsCountPower", { count, power })
      : token("summary.connectorsCount", { count });
  }
  return power > 0 ? token("summary.powerKw", { power }) : undefined;
}

/**
 * The brand's or operator's catalogued logo, gap-filled from a plain-name
 * match. Feeds publish a name and no Wikidata identity, so the match is exact
 * and scoped to charging stations in the site's country; an ambiguous name
 * gives no logo rather than a wrong one.
 */
function siteBranding(site: ChargingSite): DataSourceBranding | undefined {
  const name = site.brand ?? site.operator?.name;
  if (!name) return undefined;
  const entry = resolveBrandByName(name, {
    tagSet: "amenity=charging_station",
    country: site.country,
  });
  return gapFillBranding(undefined, undefined, () => entry);
}

/**
 * The site's credits as per-record attributions. The `ev-charging` manifest
 * declares no sources of its own — every credit comes from the providers — so
 * each result and detail carries the credits of the sources it was built from.
 * Their links come from upstream data, so only http(s) ones are kept.
 */
function siteCredits(site: ChargingSite): DataSourceAttribution[] | undefined {
  if (site.attributions.length === 0) return undefined;
  return site.attributions.map((a) => ({
    text: a.name,
    url: isSafeHttpUrl(a.url) ? a.url : "",
    ...(a.spdxLicense ? { license: a.spdxLicense } : {}),
    ...(isSafeHttpUrl(a.licenseUrl) ? { licenseUrl: a.licenseUrl } : {}),
  }));
}

/** A site's title when its sources name it nothing. */
function fallbackNameOf(site: ChargingSite): { fallbackName?: I18nToken } {
  return site.name ? {} : { fallbackName: token("siteFallbackName") };
}

function siteIdentity(site: ChargingSite): OsmIdentity | undefined {
  const operator = site.operator?.name;
  const brand = site.brand ?? operator;
  if (!operator && !brand) return undefined;
  return { ...(operator ? { operator } : {}), ...(brand ? { brand } : {}) };
}

export function mapChargingSiteToResult(site: ChargingSite): DataSourceResult {
  const availability = availabilityOf(site);
  const power = maxPowerOf(site);
  const sortValues: Record<string, number> = {};
  if (power > 0) sortValues.powerKw = power;
  if (availability) sortValues.available = availability.available;
  const result: DataSourceResult = {
    id: site.id,
    name: site.name,
    ...fallbackNameOf(site),
    coordinates: site.coordinates,
    source: site.sources[0] ?? "unknown",
    sources: site.sources,
    variant: variantOf(site),
    status: statusOf(site),
    ...(availability
      ? { availability: { available: availability.available, total: availability.total } }
      : {}),
    summary: summaryOf(site),
    operator: site.operator?.name,
    sortValues: Object.keys(sortValues).length > 0 ? sortValues : undefined,
  };
  const attributions = siteCredits(site);
  if (attributions) result.attributions = attributions;
  const branding = siteBranding(site);
  if (branding) result.branding = branding;
  return result;
}

interface ConnectorGroup {
  standard: string;
  current?: "ac" | "dc";
  powerKw?: number;
  status?: EvseStatus;
  quantity: number;
}

/** A connector's own fresh status, else its charge point's; a stale one is none. */
function connectorStatus(
  connector: ChargingConnector,
  evseStatus: EvseStatus | undefined,
): EvseStatus | undefined {
  if (connector.status !== undefined && !connector.stale) return connector.status;
  return evseStatus;
}

/** One group per standard, current, power and status, fastest first. */
function connectorGroups(site: ChargingSite): ConnectorGroup[] {
  const groups = new Map<string, ConnectorGroup>();
  for (const evse of site.evses) {
    const own = evse.quantity > 1 || evse.stale ? undefined : evse.status;
    const evseStatus = own ?? (evse.lifecycle === "planned" ? "planned" : undefined);
    for (const connector of evse.connectors) {
      const status = connectorStatus(connector, evseStatus);
      const key = [connector.standard, connector.current, connector.maxPowerKw, status].join("|");
      const group = groups.get(key);
      if (group) {
        group.quantity += evse.quantity;
        continue;
      }
      groups.set(key, {
        standard: connector.standard,
        ...(connector.current ? { current: connector.current } : {}),
        ...(connector.maxPowerKw ? { powerKw: connector.maxPowerKw } : {}),
        ...(status ? { status } : {}),
        quantity: evse.quantity,
      });
    }
  }
  const rank = (status: EvseStatus | undefined) =>
    status === undefined ? STATUS_ORDER.length : STATUS_ORDER.indexOf(status);
  return [...groups.values()]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      const power = (b.group.powerKw ?? 0) - (a.group.powerKw ?? 0);
      if (power !== 0) return power;
      if (a.group.standard !== b.group.standard) return a.index - b.index;
      return rank(a.group.status) - rank(b.group.status) || a.index - b.index;
    })
    .map(({ group }) => group);
}

function connectorsSection(site: ChargingSite): DataSourceDetailSection | null {
  const groups = connectorGroups(site);
  if (groups.length === 0) return null;
  const availability = availabilityOf(site);
  return {
    title: token("section.connectors"),
    ...(availability
      ? {
          caption: token("availability", {
            available: availability.available,
            total: availability.total,
          }),
          captionTimestamp: validObservedAt(availability.updatedAt),
        }
      : {}),
    type: "table",
    rowLayout: "connector",
    columns: [
      sharedT.row.type,
      token("column.power"),
      token("column.current"),
      token("column.qty"),
      sharedT.row.status,
    ],
    rows: groups.map((group): [Translatable, Translatable, Translatable, ...Translatable[]] => [
      standardToken(group.standard),
      group.powerKw ? `${group.powerKw} kW` : "-",
      group.current ? token(`current.${group.current}`) : "-",
      group.quantity,
      group.status ? token(`status.${group.status}`) : "",
      group.status ? STATUS_KIND[group.status] : "unknown",
    ]),
    sectionIcon: "bolt",
  };
}

function usageSection(site: ChargingSite): DataSourceDetailSection | null {
  const rows: Row[] = [];
  const audience = site.audience && AUDIENCE_TOKEN[site.audience];
  if (audience) rows.push([sharedT.row.access, audience]);
  if (site.payment.length > 0) {
    rows.push([token("row.payment"), formatPaymentMethods(site.payment)]);
  }
  if (site.authentication.length > 0) {
    rows.push([token("row.authentication"), formatPaymentMethods(site.authentication)]);
  }
  if (rows.length === 0) return null;
  return { title: token("section.usage"), type: "table", rows, sectionIcon: "payments" };
}

/** A component's price with its unit; the client formats the amount in the reader's locale. */
function priceToken(component: Component, currency: string): I18nToken {
  return token(`price.${component.type}`, { amount: money(component.price, currency) });
}

/** Days in week order, three or more in a row as a range: "Mon–Fri", "Sat, Sun". */
function daysToken(days: readonly Day[]): Translatable | undefined {
  const sorted = WEEK.filter((d) => days.includes(d));
  const parts: Translatable[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (
      end + 1 < sorted.length &&
      WEEK.indexOf(sorted[end + 1]) === WEEK.indexOf(sorted[end]) + 1
    ) {
      end++;
    }
    if (end - start >= 2) {
      parts.push(
        token("qualifier.dayRange", {
          from: token(`day.${sorted[start]}`),
          to: token(`day.${sorted[end]}`),
        }),
      );
    } else {
      for (let i = start; i <= end; i++) parts.push(token(`day.${sorted[i]}`));
    }
    start = end + 1;
  }
  return joinParts(parts, "qualifier.list");
}

function durationToken(seconds: number): I18nToken {
  const minutes = Math.round(seconds / 60);
  return minutes % 60 === 0 && minutes > 0
    ? token("qualifier.hours", { count: minutes / 60 })
    : token("qualifier.minutes", { count: minutes });
}

/** A bounded quantity as a range, a lower or an upper bound. */
function bounds(
  min: Translatable | undefined,
  max: Translatable | undefined,
  key: string,
): I18nToken | undefined {
  if (min !== undefined && max !== undefined) return token(`qualifier.${key}Range`, { min, max });
  if (min !== undefined) return token(`qualifier.${key}Min`, { min });
  if (max !== undefined) return token(`qualifier.${key}Max`, { max });
  return undefined;
}

/** When and for what a tariff element's prices apply, e.g. "Mon–Fri · 18:00–08:00 · ≥50 kW". */
function qualifierOf(
  r: EnergyTariffRestrictions | undefined,
  exclVat: boolean,
): Translatable | undefined {
  const parts: Translatable[] = [];
  if (r?.days?.length) {
    const days = daysToken(r.days);
    if (days !== undefined) parts.push(days);
  }
  if (r?.startTime && r.endTime) {
    parts.push(token("qualifier.timeRange", { from: r.startTime, to: r.endTime }));
  } else if (r?.startTime) {
    parts.push(token("qualifier.timeFrom", { from: r.startTime }));
  } else if (r?.endTime) {
    parts.push(token("qualifier.timeUntil", { to: r.endTime }));
  }
  if (r?.startDate && r.endDate) {
    parts.push(token("qualifier.dateRange", { from: r.startDate, to: r.endDate }));
  } else if (r?.startDate) {
    parts.push(token("qualifier.dateFrom", { from: r.startDate }));
  } else if (r?.endDate) {
    parts.push(token("qualifier.dateUntil", { to: r.endDate }));
  }
  const power = bounds(r?.minPowerKw, r?.maxPowerKw, "power");
  if (power) parts.push(power);
  const kwh = bounds(r?.minKwh, r?.maxKwh, "kwh");
  if (kwh) parts.push(kwh);
  const current = bounds(r?.minCurrentA, r?.maxCurrentA, "current");
  if (current) parts.push(current);
  const minDuration = r?.minDurationSec ? durationToken(r.minDurationSec) : undefined;
  const maxDuration = r?.maxDurationSec ? durationToken(r.maxDurationSec) : undefined;
  const duration = bounds(minDuration, maxDuration, "duration");
  if (duration) parts.push(duration);
  if (r?.reservation === "reservation") parts.push(token("qualifier.reservation"));
  if (r?.reservation === "reservation_expires") parts.push(token("qualifier.reservationExpires"));
  if (exclVat) parts.push(token("qualifier.exclVat"));
  return joinParts(parts, "qualifier.and");
}

/** The connectors a tariff names, as the Connectors table groups them, without status. */
function applicabilityOf(site: ChargingSite, tariff: EnergyTariff): ConnectorGroup[] {
  const groups = new Map<string, ConnectorGroup>();
  for (const { connector } of connectors(site)) {
    if (!connector.tariffIds.includes(tariff.id)) continue;
    const key = [connector.standard, connector.current, connector.maxPowerKw].join("|");
    if (groups.has(key)) continue;
    groups.set(key, {
      standard: connector.standard,
      ...(connector.current ? { current: connector.current } : {}),
      ...(connector.maxPowerKw ? { powerKw: connector.maxPowerKw } : {}),
      quantity: 1,
    });
  }
  return [...groups.values()];
}

/**
 * Names the connector groups a tariff applies to, e.g. "CCS (Type 2) · DC ·
 * 150 kW": the parts the Connectors table shows, so the label reads as a
 * pointer into it. Power and current are stated only when every group agrees.
 * A tariff no connector names applies to the whole site.
 */
function applicabilityLabel(groups: ConnectorGroup[]): Translatable {
  if (groups.length === 0) return token("pricing.allConnectors");
  const distinct = <T>(values: (T | undefined)[]): T[] =>
    [...new Set(values)].filter((v): v is T => v !== undefined);
  const standards = distinct(groups.map((g) => g.standard));
  const currents = distinct(groups.map((g) => g.current));
  const powers = distinct(groups.map((g) => g.powerKw));
  const parts: Translatable[] = [];
  const types = joinParts(standards.map(standardToken));
  if (types !== undefined) parts.push(types);
  if (currents.length === 1 && groups.every((g) => g.current)) {
    parts.push(token(`current.${currents[0]}`));
  }
  if (powers.length === 1 && groups.every((g) => g.powerKw)) parts.push(`${powers[0]} kW`);
  return joinParts(parts, "qualifier.and") ?? token("pricing.allConnectors");
}

type PricingRow = [Translatable, Translatable, Translatable];

const TARIFF_TYPES = new Set(Object.keys(strings.tariffType));

/**
 * Names for several tariffs of the same connectors that tell them apart:
 * their types, else their descriptions, else their positions.
 */
function tariffNames(tariffs: EnergyTariff[]): Translatable[] {
  const distinct = (values: (string | undefined)[]): values is string[] =>
    values.every((v) => v !== undefined) && new Set(values).size === values.length;
  const types = tariffs.map((t) => (t.type && TARIFF_TYPES.has(t.type) ? t.type : undefined));
  if (distinct(types)) return types.map((type) => token(`tariffType.${type}`));
  const texts = tariffs.map((t) => t.altText);
  if (distinct(texts)) return texts;
  return tariffs.map((_, i) => token("pricing.tariffN", { n: i + 1 }));
}

/**
 * Each tariff's row label, or undefined where its rows name their kind of
 * price. When the tariffs price different connectors differently — two DC
 * bays at €0.69/kWh, one AC unit at €0.49/kWh — every label names the
 * connectors, the kind being readable from the price's unit. Several tariffs
 * for the same connectors are named apart as well; a tariff whose content
 * repeats an earlier one's for the same connectors is in `repeats` and shown
 * only once.
 */
function groupLabels(site: ChargingSite): {
  labels: (Translatable | undefined)[];
  repeats: Set<number>;
} {
  const connectorLabels = site.tariffs.map((t) => applicabilityLabel(applicabilityOf(site, t)));
  const keys = connectorLabels.map((label) => JSON.stringify(label));
  const byConnector = new Set(keys).size > 1;
  const labels: (Translatable | undefined)[] = site.tariffs.map(() => undefined);
  const repeats = new Set<number>();
  for (const key of new Set(keys)) {
    // A feed that repeats a tariff under another id prices the same connectors the same way.
    const contents = new Set<string>();
    const members = keys.flatMap((k, i) => {
      if (k !== key) return [];
      const { currency, elements, priceIncludesVat } = site.tariffs[i];
      const content = JSON.stringify({ currency, elements, priceIncludesVat });
      if (contents.has(content)) {
        repeats.add(i);
        return [];
      }
      contents.add(content);
      return [i];
    });
    if (members.length === 1) {
      if (byConnector) labels[members[0]] = connectorLabels[members[0]];
      continue;
    }
    const names = tariffNames(members.map((i) => site.tariffs[i]));
    for (const [n, i] of members.entries()) {
      labels[i] = byConnector
        ? token("pricing.tariffFor", { connectors: connectorLabels[i], tariff: names[n] })
        : names[n];
    }
  }
  return { labels, repeats };
}

/**
 * One row per tariff element: its prices, and when they apply beneath, under
 * its tariff's label, else the kind of its prices. Identical rows (feeds that
 * repeat a tariff) show once; a run of rows under the same label names it once.
 */
function pricingRows(site: ChargingSite): PricingRow[] {
  const { labels, repeats } = groupLabels(site);
  const rows: PricingRow[] = [];
  const seen = new Set<string>();
  for (const [index, tariff] of site.tariffs.entries()) {
    if (repeats.has(index)) continue;
    for (const element of tariff.elements) {
      const kinds = [...new Set(element.components.map((c) => c.type))];
      const label = labels[index] ?? joinParts(kinds.map((kind) => token(`pricing.${kind}`))) ?? "";
      const price =
        joinParts(
          element.components.map((c) => priceToken(c, tariff.currency)),
          "pricing.plus",
        ) ?? "";
      const conditions = qualifierOf(element.restrictions, tariff.priceIncludesVat === false);
      const row: PricingRow = [label, price, conditions ?? ""];
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  const grouped = labels.some((label) => label !== undefined);
  return rows.map((row, index) =>
    index > 0 && grouped && JSON.stringify(row[0]) === JSON.stringify(rows[index - 1][0])
      ? ["", row[1], row[2]]
      : row,
  );
}

/** Each tariff's own page, or its description where there is no page; each once. */
function tariffLinks(site: ChargingSite): { label: Translatable; url?: string }[] {
  const seen = new Set<string>();
  const links: { label: Translatable; url?: string }[] = [];
  for (const tariff of site.tariffs) {
    const url = isSafeHttpUrl(tariff.url) ? tariff.url : undefined;
    if (!url && !tariff.altText) continue;
    const key = `${tariff.altText ?? ""}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      label: tariff.altText ?? token("pricing.tariffDetails"),
      ...(url ? { url } : {}),
    });
  }
  return links;
}

/**
 * The caption promises a walk-up price only when every tariff is the ad-hoc
 * one; otherwise the prices are what the operator published, which may be a
 * roaming rate.
 */
function pricingSection(site: ChargingSite): DataSourceDetailSection | null {
  const base = { title: sharedT.section.pricing, sectionIcon: "payments" } as const;
  const rows = pricingRows(site);
  if (rows.length > 0) {
    const links = tariffLinks(site);
    return {
      ...base,
      caption: site.tariffs.every((t) => t.type === "ad_hoc")
        ? token("pricing.note")
        : token("pricing.noteOperator"),
      type: "table",
      // The pricing layout stacks the conditions under the label, so the cell stays when empty.
      rowLayout: "pricing",
      rows,
      ...(links.length > 0 ? { links } : {}),
    };
  }
  if (site.tariffText) return { ...base, type: "text", content: site.tariffText };
  return null;
}

export function mapChargingSiteToDetail(site: ChargingSite): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];
  const connectorTable = connectorsSection(site);
  if (connectorTable) sections.push(connectorTable);
  const pricing = pricingSection(site);
  if (pricing) sections.push(pricing);
  const usage = usageSection(site);
  if (usage) sections.push(usage);
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

  const audience = site.audience && AUDIENCE_TOKEN[site.audience];
  const operatorWebsite = isSafeHttpUrl(site.operator?.website) ? site.operator.website : undefined;
  // The site's own website stands on its own unless the operator's is the link already.
  const website = !operatorWebsite && isSafeHttpUrl(site.website) ? site.website : undefined;
  const detail: DataSourceDetail = {
    id: site.id,
    sources: site.sources,
    name: site.name,
    ...fallbackNameOf(site),
    coordinates: site.coordinates,
    identity: siteIdentity(site),
    address: site.address ? { line1: site.address } : undefined,
    operator: site.operator
      ? { name: site.operator.name, ...(operatorWebsite ? { url: operatorWebsite } : {}) }
      : undefined,
    ...(website ? { website } : {}),
    usageInfo: audience ? { type: audience } : undefined,
    openingHours: site.openingHours,
    sections,
  };
  const attributions = siteCredits(site);
  if (attributions) detail.attributions = attributions;
  const branding = siteBranding(site);
  if (branding) detail.branding = branding;
  return detail;
}
