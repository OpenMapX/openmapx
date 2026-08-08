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
  EvTariffConnectorGroup,
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

// Formats a duration in minutes as "2 h" (whole hours) or "90 min", keeping
// the qualifier terse and language-neutral like the "≤22 kW" parts.
function formatDurationMinutes(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

// Renders a tariff's `restrictions` as a compact human-readable qualifier
// (e.g. "AC · ≤22 kW", "≥2 h") so an AC and a DC energy tariff, or a base
// price and a duration-gated blocking fee, don't collapse into two
// identically-labelled rows. Parts are universal/numeric (current type, power,
// time-of-day, duration) so no further i18n is needed.
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
  const { minDurationMinutes, maxDurationMinutes } = restrictions;
  if (minDurationMinutes !== undefined && maxDurationMinutes !== undefined) {
    parts.push(
      `${formatDurationMinutes(minDurationMinutes)}–${formatDurationMinutes(maxDurationMinutes)}`,
    );
  } else if (minDurationMinutes !== undefined) {
    parts.push(`≥${formatDurationMinutes(minDurationMinutes)}`);
  } else if (maxDurationMinutes !== undefined) {
    parts.push(`≤${formatDurationMinutes(maxDurationMinutes)}`);
  }
  return parts.join(" · ");
}

/**
 * Names the connector groups a tariff was joined to, e.g. "CCS · DC · 60 kW".
 * The parts are the same ones the Connectors table above shows, so the label
 * reads as a pointer into it; quantity is left out because it lives there.
 * Power and current are only stated when the whole group agrees on them —
 * a tariff spanning 11 kW and 22 kW plugs says just the types.
 */
function applicabilityLabel(groups: EvTariffConnectorGroup[] | undefined): string | undefined {
  if (!groups?.length) return undefined;
  const distinct = <T>(values: (T | undefined)[]): T[] =>
    Array.from(new Set(values.filter((value): value is T => value !== undefined)));
  const types = distinct(groups.map((group) => group.type));
  const currents = distinct(groups.map((group) => group.currentType));
  const powers = distinct(groups.map((group) => group.powerKw));

  const parts: string[] = [];
  if (types.length > 0) parts.push(types.join(" / "));
  if (currents.length === 1) parts.push(currents[0]);
  if (powers.length === 1) parts.push(`${powers[0]} kW`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

interface TariffRow {
  label: Translatable;
  price: Translatable;
  conditions: string;
}

/**
 * One row per price component. The label is normally the tariff dimension
 * ("Energy", "Time"), but a station whose tariffs price different connectors
 * differently — two DC bays at €0.46/kWh, one AC unit at €0.40/kWh — would then
 * show two identical "Energy" rows with no way to tell which plug each price is
 * for. In that case the connector applicability becomes the label instead; the
 * dimension is still readable from the price's unit (/kWh, /min, /session).
 */
function tariffRows(station: EvChargingStation): TariffRow[] {
  const tariffs = station.tariffs ?? [];
  const labels = tariffs.map((tariff) => applicabilityLabel(tariff.appliesTo));
  // A single applicability tells the reader nothing they can act on — only a
  // split across connectors does. Tariffs with no `appliesTo` count as their
  // own "station-wide" bucket, since that is exactly what they mean.
  const byApplicability =
    new Set(labels.map((label) => label ?? "")).size > 1
      ? labels.map((label): Translatable => label ?? token("allConnectors"))
      : undefined;

  const rows: TariffRow[] = [];
  const seen = new Set<string>();
  for (const [index, tariff] of tariffs.entries()) {
    const conditions = tariffQualifier(tariff.restrictions);
    for (const element of tariff.elements) {
      const row: TariffRow = {
        label: byApplicability?.[index] ?? TARIFF_DIMENSION_TOKENS[element.type],
        price: formatTariff(element),
        conditions,
      };
      // NL stations often carry several OCPI tariffs whose price components
      // are byte-identical (same dimension, price and restrictions), which
      // would otherwise render duplicate rows in the Pricing table.
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }

  // Consecutive rows priced for the same connectors repeat their label; blank
  // the repeats so the group reads as one block. Compared by value, since the
  // station-wide label is a freshly built token per row.
  return rows.map((row, index) =>
    index > 0 &&
    byApplicability &&
    JSON.stringify(row.label) === JSON.stringify(rows[index - 1].label)
      ? { ...row, label: "" }
      : row,
  );
}

/**
 * The pricing caption may only promise a walk-up price when every tariff is
 * flagged as ad-hoc/direct payment at the source; otherwise the section is
 * whatever the operator published, which can already be a roaming rate.
 */
function pricingCaption(station: EvChargingStation): I18nToken {
  const tariffs = station.tariffs ?? [];
  return tariffs.every((tariff) => tariff.isDirectPayment)
    ? token("pricingNote")
    : token("pricingNoteOperator");
}

// Whole-value spellings that per-word casing cannot produce.
const PAYMENT_BRAND_CASING: Record<string, string> = {
  paypal: "PayPal",
  applepay: "Apple Pay",
  "apple pay": "Apple Pay",
  googlepay: "Google Pay",
  "google pay": "Google Pay",
};

// Single words that are acronyms or brands rather than ordinary nouns. Applied
// per word, so they still work inside a compound like "kreditkarte (nfc)".
const PAYMENT_WORD_CASING: Record<string, string> = {
  nfc: "NFC",
  rfid: "RFID",
  ec: "EC",
  paypal: "PayPal",
};

/**
 * Upper-case the first letter of each word, leaving separators alone.
 *
 * Unicode-aware on purpose: an ASCII `\b\w` boundary treats "ä" as a separator,
 * so "lesegerät" came out as "LesegeräT".
 */
function titleCasePayment(value: string): string {
  return value.replace(
    /\p{L}[\p{L}\p{N}]*/gu,
    (word) => PAYMENT_WORD_CASING[word] ?? word.charAt(0).toUpperCase() + word.slice(1),
  );
}

// Payment methods arrive as lowercase tokens (from OSM `payment:*` tags or
// provider feeds), e.g. "mastercard", "debit cards", "apple_pay". Render them
// as readable text: brand-cased where known, otherwise title-cased per word.
export function formatPaymentMethods(methods: string[]): string {
  const seen = new Set<string>();
  const formatted: string[] = [];
  for (const raw of methods) {
    const normalized = raw.trim().toLowerCase().replace(/_/g, " ");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    formatted.push(PAYMENT_BRAND_CASING[normalized] ?? titleCasePayment(normalized));
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
      rowLayout: "connector",
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
    const links = tariffLinks(station);
    sections.push({
      title: sharedT.section.pricing,
      caption: pricingCaption(station),
      type: "table",
      // The pricing layout stacks the conditions under the label rather than
      // giving them a column, so the cell stays present even when empty.
      rowLayout: "pricing",
      rows: structuredTariffRows.map(
        ({ label, price, conditions }): [Translatable, Translatable, Translatable] => [
          label,
          price,
          conditions,
        ],
      ),
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
