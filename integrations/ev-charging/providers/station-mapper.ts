import type { DataSourceDetail, DataSourceDetailSection, DataSourceResult } from "@openmapx/core";
import type { EvChargingConnector, EvChargingStation } from "@openmapx/mobility-core/ev-charging";

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

function buildSummary(station: EvChargingStation): string | undefined {
  const parts: string[] = [];
  const totalQty = station.connectors.reduce((sum, conn) => sum + connectorQuantity(conn), 0);
  const connectorNames = new Set(station.connectors.map((conn) => conn.type).filter(Boolean));

  if (totalQty > 0 && connectorNames.size > 0) {
    parts.push(`${totalQty}x ${Array.from(connectorNames).join(", ")}`);
  } else if (totalQty > 0) {
    parts.push(`${totalQty} connectors`);
  }

  const maxPower = getMaxPower(station);
  if (maxPower > 0) parts.push(`${maxPower} kW`);
  if (station.operator?.name) parts.push(station.operator.name);
  return parts.length > 0 ? parts.join(" · ") : undefined;
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

function formatTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function connectorRows(station: EvChargingStation): (string | number)[][] {
  return [...station.connectors]
    .sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0))
    .map((conn) => [
      conn.type ?? "Unknown",
      formatPower(conn.powerKw),
      conn.currentType ?? "-",
      connectorQuantity(conn),
      conn.status ?? station.status ?? "-",
    ]);
}

export function mapStationToDetail(station: EvChargingStation): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  if (station.connectors.length > 0) {
    sections.push({
      title: "Connectors",
      type: "table",
      columns: ["Type", "Power", "Current", "Qty", "Status"],
      rows: connectorRows(station),
      sectionIcon: "bolt",
    });
  }

  const usageItems: string[] = [];
  if (station.usageType) usageItems.push(`Access: ${station.usageType}`);
  if (station.usageCost) usageItems.push(`Cost: ${station.usageCost}`);
  if (station.paymentMethods?.length)
    usageItems.push(`Payment: ${station.paymentMethods.join(", ")}`);
  if (station.membershipRequired !== undefined) {
    usageItems.push(`Membership required: ${station.membershipRequired ? "Yes" : "No"}`);
  }
  if (usageItems.length > 0) {
    sections.push({ title: "Usage", type: "list", items: usageItems, sectionIcon: "payments" });
  }

  if (station.access) {
    sections.push({ title: "Access", type: "text", content: station.access, sectionIcon: "info" });
  }

  if (station.notes?.length) {
    sections.push({
      title: "Notes",
      type: "list",
      items: station.notes,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  const sourceRows: (string | number)[][] = [];
  sourceRows.push(["Sources", station.sources.join(", ")]);
  const updated = formatTimestamp(station.updatedAt);
  if (updated) sourceRows.push(["Last Updated", updated]);
  if (station.sourceUrl) sourceRows.push(["Source URL", station.sourceUrl]);
  if (sourceRows.length > 0) {
    sections.push({
      title: "Source",
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
    attributions: station.attributions,
    address: station.address,
    operator: station.operator,
    usageInfo:
      station.usageType || station.usageCost || station.membershipRequired !== undefined
        ? {
            type: station.usageType ?? "Public",
            cost: station.usageCost,
            membershipRequired: station.membershipRequired,
          }
        : undefined,
    openingHours: station.openingHours,
    sections,
    osmTags: station.osmTags,
  };
}
