import type {
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
  OsmIdentity,
} from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type {
  EvChargingConnector,
  EvChargingPriceComponent,
  EvChargingStation,
  EvChargingTariffRestriction,
  EvTariffDimension,
} from "@openmapx/mobility-core/ev-charging";
import { cleanString, groupConnectors, isSafeHttpUrl } from "./utils.js";

function stationIdentity(station: EvChargingStation): OsmIdentity | undefined {
  const operator = station.operator?.name;
  const legal = station.operator?.legalName;
  if (!operator && !legal) return undefined;
  const identity: OsmIdentity = {};
  if (operator) {
    identity.operator = operator;
    identity.brand = operator;
  }
  if (legal && legal !== operator) {
    identity.network = legal;
  }
  return identity;
}

function getMaxPower(station: EvChargingStation): number {
  return station.connectors.reduce((max, connector) => {
    if (connector.powerKw && connector.powerKw > max) return connector.powerKw;
    return max;
  }, 0);
}

export function getStationVariant(station: EvChargingStation): string {
  const maxPower = getMaxPower(station);
  if (maxPower === 0) return "unknown";
  if (maxPower <= 22) return "slow";
  if (maxPower <= 100) return "fast";
  return "ultra-rapid";
}

function connectorQuantity(connector: EvChargingConnector): number {
  return connector.quantity && connector.quantity > 0 ? connector.quantity : 1;
}

function buildSummary(station: EvChargingStation): I18nToken | undefined {
  const totalQty = station.connectors.reduce((sum, conn) => sum + connectorQuantity(conn), 0);
  const connectorNames = new Set(station.connectors.map((conn) => conn.type).filter(Boolean));
  const maxPower = getMaxPower(station);

  if (totalQty > 0 && connectorNames.size > 0) {
    if (maxPower > 0) {
      return token("summary.connectorsTypedPower", {
        count: totalQty,
        types: Array.from(connectorNames).join(", "),
        power: maxPower,
      });
    }
    return token("summary.connectorsTyped", {
      count: totalQty,
      types: Array.from(connectorNames).join(", "),
    });
  }
  if (totalQty > 0) {
    if (maxPower > 0) {
      return token("summary.connectorsCountPower", { count: totalQty, power: maxPower });
    }
    return token("summary.connectorsCount", { count: totalQty });
  }
  if (maxPower > 0) {
    return token("summary.powerKw", { power: maxPower });
  }
  return undefined;
}

export function mapStationToResult(station: EvChargingStation): DataSourceResult {
  const maxPowerKw = getMaxPower(station);
  const sortValues: Record<string, number> = {};
  if (maxPowerKw > 0) sortValues.powerKw = maxPowerKw;
  if (station.availability) sortValues.available = station.availability.available;

  return {
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: station.sources[0],
    sources: station.sources,
    attributions: station.attributions,
    variant: getStationVariant(station),
    status: station.status,
    ...(station.availability
      ? {
          availability: {
            available: station.availability.available,
            total: station.availability.total,
          },
        }
      : {}),
    summary: buildSummary(station),
    operator: station.operator?.name,
    sortValues: Object.keys(sortValues).length > 0 ? sortValues : undefined,
  };
}

function formatPower(value: number | undefined): string {
  return value ? `${value} kW` : "-";
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF",
};

// A price component arrives with an ISO currency code (from OCP/OCM tariff
// feeds). Known codes render with their conventional symbol glued to the
// amount (€0.59); unknown codes fall back to showing the bare code with a
// space (SEK 0.59) so the price stays honest instead of silently mislabeled.
export function formatMoney(price: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const amount = price.toFixed(2);
  const prefix = /[a-zA-Z]/.test(symbol) ? `${symbol} ` : symbol;
  return `${prefix}${amount}`;
}

// The unit suffix (/kWh, /min, ...) lives in the strings catalog so it
// localizes; the token key varies per tariff dimension, the formatted money
// amount is passed through as the token's only param.
const PRICE_DIMENSION_TOKENS: Record<EvTariffDimension, string> = {
  energy: "priceEnergy",
  time: "priceTime",
  flat: "priceFlat",
  parking: "priceParking",
};

export function formatTariff(component: EvChargingPriceComponent): I18nToken {
  return token(PRICE_DIMENSION_TOKENS[component.type], {
    amount: formatMoney(component.price, component.currency),
  });
}

const TARIFF_DIMENSION_TOKENS: Record<EvTariffDimension, I18nToken> = {
  energy: token("row.pricingEnergy"),
  time: token("row.pricingTime"),
  flat: token("row.pricingFlat"),
  parking: token("row.pricingParking"),
};

// Renders a tariff's `restrictions` as a compact human-readable qualifier
// (e.g. "AC · ≤22 kW") so an AC and a DC energy tariff don't collapse into
// two identically-labelled "Energy" rows. Parts are universal/numeric
// (current type, power, time-of-day) so no further i18n is needed.
function tariffQualifier(restrictions: EvChargingTariffRestriction | undefined): string {
  if (!restrictions) return "";
  const parts: string[] = [];
  if (restrictions.currentType) parts.push(restrictions.currentType.toUpperCase());
  const { minPowerKw, maxPowerKw, timeOfDayStart, timeOfDayEnd } = restrictions;
  if (minPowerKw !== undefined && maxPowerKw !== undefined) {
    parts.push(`${minPowerKw}–${maxPowerKw} kW`);
  } else if (minPowerKw !== undefined) {
    parts.push(`≥${minPowerKw} kW`);
  } else if (maxPowerKw !== undefined) {
    parts.push(`≤${maxPowerKw} kW`);
  }
  if (timeOfDayStart && timeOfDayEnd) {
    parts.push(`${timeOfDayStart}–${timeOfDayEnd}`);
  }
  return parts.join(" · ");
}

type TariffTableRows = [I18nToken, Translatable][] | [Translatable, Translatable, Translatable][];

// Two shapes: a plain [label, price] table when no tariff carries a
// restriction, or a [label, price, conditions] table once at least one row
// needs to be disambiguated. A partial-column ("only some rows have
// restrictions") table would leave an all-empty column, so the switch is
// all-or-nothing across the whole pricing section.
function tariffRows(station: EvChargingStation): TariffTableRows {
  const rows: [I18nToken, Translatable, string][] = [];
  for (const tariff of station.tariffs ?? []) {
    const qualifier = tariffQualifier(tariff.restrictions);
    for (const element of tariff.elements) {
      rows.push([TARIFF_DIMENSION_TOKENS[element.type], formatTariff(element), qualifier]);
    }
  }
  const hasQualifier = rows.some(([, , qualifier]) => qualifier.length > 0);
  if (!hasQualifier) {
    return rows.map(([label, price]): [I18nToken, Translatable] => [label, price]);
  }
  return rows.map(([label, price, qualifier]): [Translatable, Translatable, Translatable] => [
    label,
    price,
    qualifier || "-",
  ]);
}

// Brand spellings that title-casing alone gets wrong.
const PAYMENT_BRAND_CASING: Record<string, string> = {
  paypal: "PayPal",
  applepay: "Apple Pay",
  "apple pay": "Apple Pay",
  googlepay: "Google Pay",
  "google pay": "Google Pay",
  nfc: "NFC",
};

// Payment methods arrive as lowercase tokens (from OSM `payment:*` tags or
// provider feeds), e.g. "mastercard", "debit cards", "apple_pay". Render them
// as readable text: brand-cased where known, otherwise title-cased per word.
function formatPaymentMethods(methods: string[]): string {
  const seen = new Set<string>();
  const formatted: string[] = [];
  for (const raw of methods) {
    const normalized = raw.trim().toLowerCase().replace(/_/g, " ");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    formatted.push(
      PAYMENT_BRAND_CASING[normalized] ?? normalized.replace(/\b\w/g, (char) => char.toUpperCase()),
    );
  }
  return formatted.join(", ");
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

function connectorRows(
  station: EvChargingStation,
): [Translatable, Translatable, Translatable, ...Translatable[]][] {
  return groupConnectors(station.connectors).map(
    (conn): [Translatable, Translatable, Translatable, Translatable, Translatable] => [
      conn.type ?? sharedT.value.unknown,
      formatPower(conn.powerKw),
      conn.currentType ?? "-",
      connectorQuantity(conn),
      conn.status ?? station.status ?? "-",
    ],
  );
}

/**
 * Distinct (altText, sourceUrl) pairs collected across a station's tariffs,
 * for rendering an OCPI `tariff_alt_text`/`tariff_alt_url` blurb+link beneath
 * the Pricing section. `url` is omitted when a tariff carries descriptive
 * text but no link target; entries with neither are skipped entirely.
 */
function tariffLinks(
  station: EvChargingStation,
): { label: Translatable; url?: string }[] | undefined {
  const seen = new Set<string>();
  const links: { label: Translatable; url?: string }[] = [];
  for (const tariff of station.tariffs ?? []) {
    const altText = cleanString(tariff.altText);
    const url = isSafeHttpUrl(tariff.sourceUrl) ? tariff.sourceUrl : undefined;
    if (!altText && !url) continue;
    const key = `${altText ?? ""}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label: altText ?? token("tariffDetails"), url });
  }
  return links.length > 0 ? links : undefined;
}

export function mapStationToDetail(
  station: EvChargingStation,
  // Resolve a source id to its display name (from the integration manifest's
  // dataSources). Defaults to the id itself so the mapper stays standalone.
  resolveSourceName: (id: string) => string = (id) => id,
): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  if (station.connectors.length > 0) {
    sections.push({
      title: token("section.connectors"),
      ...(station.availability
        ? {
            caption: token("availability", {
              available: station.availability.available,
              total: station.availability.total,
            }),
            captionTimestamp: station.availability.updatedAt,
          }
        : {}),
      type: "table",
      columns: [
        sharedT.row.type,
        token("column.power"),
        token("column.current"),
        token("column.qty"),
        sharedT.row.status,
      ],
      rows: connectorRows(station),
      sectionIcon: "bolt",
    });
  }

  const structuredTariffRows = tariffRows(station);

  const usageRows: [I18nToken, Translatable][] = [];
  if (station.usageType) usageRows.push([sharedT.row.access, station.usageType]);
  // Structured tariffs render their own Pricing section below; the free-text
  // cost stays only as a fallback when no structured data is available.
  if (structuredTariffRows.length === 0 && station.usageCost) {
    usageRows.push([token("row.cost"), station.usageCost]);
  }
  if (station.paymentMethods?.length) {
    usageRows.push([token("row.payment"), formatPaymentMethods(station.paymentMethods)]);
  }
  if (station.membershipRequired !== undefined) {
    usageRows.push([
      token("row.membershipRequired"),
      station.membershipRequired ? sharedT.value.yes : sharedT.value.no,
    ]);
  }
  if (usageRows.length > 0) {
    sections.push({
      title: token("section.usage"),
      type: "table",
      rows: usageRows,
      sectionIcon: "payments",
    });
  }

  if (structuredTariffRows.length > 0) {
    const hasConditionsColumn = structuredTariffRows[0].length === 3;
    const links = tariffLinks(station);
    sections.push({
      title: sharedT.section.pricing,
      caption: token("pricingNote"),
      type: "table",
      ...(hasConditionsColumn
        ? { columns: [sharedT.row.type, token("column.price"), token("column.conditions")] }
        : {}),
      rows: structuredTariffRows,
      sectionIcon: "payments",
      ...(links ? { links } : {}),
    });
  }

  if (station.access) {
    sections.push({
      title: sharedT.section.access,
      type: "text",
      content: station.access,
      sectionIcon: "info",
    });
  }

  if (station.notes?.length) {
    sections.push({
      title: sharedT.section.notes,
      type: "list",
      items: station.notes,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  const sourceRows: [I18nToken, Translatable][] = [];
  sourceRows.push([sharedT.row.sources, station.sources.map(resolveSourceName).join(", ")]);
  const updated = formatTimestamp(station.updatedAt);
  if (updated) sourceRows.push([sharedT.row.lastUpdated, updated]);
  if (station.sourceUrl) sourceRows.push([sharedT.row.sourceUrl, station.sourceUrl]);
  if (sourceRows.length > 0) {
    sections.push({
      title: sharedT.section.source,
      type: "table",
      rows: sourceRows,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  return {
    id: station.id,
    sources: station.sources,
    name: station.name,
    coordinates: station.coordinates,
    identity: stationIdentity(station),
    attributions: station.attributions,
    address: station.address,
    operator: station.operator,
    usageInfo:
      station.usageType || station.usageCost || station.membershipRequired !== undefined
        ? {
            type: station.usageType ?? sharedT.value.public,
            cost: station.usageCost,
            membershipRequired: station.membershipRequired,
          }
        : undefined,
    openingHours: station.openingHours,
    sections,
    osmTags: station.osmTags,
  };
}
