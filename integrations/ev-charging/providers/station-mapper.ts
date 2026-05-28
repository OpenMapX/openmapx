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
import type { EvChargingConnector, EvChargingStation } from "@openmapx/mobility-core/ev-charging";

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
  return {
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: station.sources[0],
    sources: station.sources,
    attributions: station.attributions,
    variant: getStationVariant(station),
    status: station.status,
    summary: buildSummary(station),
    operator: station.operator?.name,
    sortValues: getMaxPower(station) > 0 ? { powerKw: getMaxPower(station) } : undefined,
  };
}

function formatPower(value: number | undefined): string {
  return value ? `${value} kW` : "-";
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
  return [...station.connectors]
    .sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0))
    .map((conn): [Translatable, Translatable, Translatable, Translatable, Translatable] => [
      conn.type ?? sharedT.value.unknown,
      formatPower(conn.powerKw),
      conn.currentType ?? "-",
      connectorQuantity(conn),
      conn.status ?? station.status ?? "-",
    ]);
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

  const usageRows: [I18nToken, Translatable][] = [];
  if (station.usageType) usageRows.push([sharedT.row.access, station.usageType]);
  if (station.usageCost) usageRows.push([token("row.cost"), station.usageCost]);
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
