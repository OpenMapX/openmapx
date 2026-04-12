import type { DataSourceDetail, DataSourceResult } from "@openmapx/core";
import type { OcmPoi } from "./ocm-types.js";

function getMaxPower(poi: OcmPoi): number {
  if (!poi.Connections?.length) return 0;
  let max = 0;
  for (const conn of poi.Connections) {
    if (conn.PowerKW && conn.PowerKW > max) {
      max = conn.PowerKW;
    }
  }
  return max;
}

export function getVariant(poi: OcmPoi): string {
  const maxPower = getMaxPower(poi);
  if (maxPower === 0) return "unknown";
  if (maxPower <= 22) return "slow";
  if (maxPower <= 100) return "fast";
  return "ultra-rapid";
}

export function getStatus(poi: OcmPoi): string {
  if (poi.StatusType?.IsOperational === false) {
    const title = poi.StatusType.Title?.toLowerCase() ?? "";
    if (title.includes("planned") || title.includes("construction")) {
      return "planned";
    }
    return "not-operational";
  }
  if (poi.StatusType?.IsOperational === true) {
    return "operational";
  }
  return "unknown";
}

export function buildSummary(poi: OcmPoi): string {
  const parts: string[] = [];

  // Total connector count
  const totalQty = poi.Connections?.reduce((sum, c) => sum + (c.Quantity ?? 1), 0) ?? 0;

  // Unique connector type names
  const connectorNames = new Set<string>();
  for (const conn of poi.Connections ?? []) {
    if (conn.ConnectionType?.Title) {
      connectorNames.add(conn.ConnectionType.Title);
    }
  }

  if (totalQty > 0 && connectorNames.size > 0) {
    parts.push(`${totalQty}x ${Array.from(connectorNames).join(", ")}`);
  } else if (totalQty > 0) {
    parts.push(`${totalQty} connectors`);
  }

  // Max power
  const maxPower = getMaxPower(poi);
  if (maxPower > 0) {
    parts.push(`${maxPower}kW`);
  }

  // Operator
  if (poi.OperatorInfo?.Title && !poi.OperatorInfo.IsPrivateIndividual) {
    parts.push(poi.OperatorInfo.Title);
  }

  return parts.join(" \u00B7 ");
}

export function mapOcmToResult(poi: OcmPoi): DataSourceResult {
  return {
    id: `ocm:${poi.ID}`,
    name: poi.AddressInfo.Title || "EV Charging Station",
    coordinates: [poi.AddressInfo.Longitude, poi.AddressInfo.Latitude],
    source: "ocm",
    variant: getVariant(poi),
    status: getStatus(poi),
    summary: buildSummary(poi),
    operator: poi.OperatorInfo?.Title,
  };
}

export function mapOcmToDetail(poi: OcmPoi): DataSourceDetail {
  const sections: DataSourceDetail["sections"] = [];

  // Connector table
  if (poi.Connections?.length) {
    const rows: (string | number)[][] = poi.Connections.map((conn) => [
      conn.ConnectionType?.Title ?? "Unknown",
      conn.PowerKW ? `${conn.PowerKW} kW` : "-",
      conn.CurrentType?.Title ?? "-",
      conn.Quantity ?? 1,
      conn.StatusType?.Title ?? poi.StatusType?.Title ?? "-",
    ]);

    sections.push({
      title: "Connectors",
      type: "table",
      columns: ["Type", "Power", "Current", "Qty", "Status"],
      rows,
    });
  }

  // Usage info as text section
  if (poi.UsageCost || poi.UsageType?.Title) {
    const usageLines: string[] = [];
    if (poi.UsageType?.Title) usageLines.push(`Access: ${poi.UsageType.Title}`);
    if (poi.UsageCost) usageLines.push(`Cost: ${poi.UsageCost}`);
    sections.push({
      title: "Usage",
      type: "list",
      items: usageLines,
    });
  }

  // Access comments
  if (poi.AddressInfo.AccessComments) {
    sections.push({
      title: "Access",
      type: "text",
      content: poi.AddressInfo.AccessComments,
    });
  }

  return {
    id: `ocm:${poi.ID}`,
    sources: ["ocm"],
    name: poi.AddressInfo.Title || "EV Charging Station",
    coordinates: [poi.AddressInfo.Longitude, poi.AddressInfo.Latitude],
    address: {
      line1: poi.AddressInfo.AddressLine1,
      town: poi.AddressInfo.Town,
      state: poi.AddressInfo.StateOrProvince,
      postcode: poi.AddressInfo.Postcode,
      country: poi.AddressInfo.Country?.Title,
    },
    operator: poi.OperatorInfo
      ? {
          name: poi.OperatorInfo.Title,
          url: poi.OperatorInfo.WebsiteURL,
        }
      : undefined,
    usageInfo: poi.UsageType
      ? {
          type: poi.UsageType.Title,
          cost: poi.UsageCost,
          membershipRequired: poi.UsageType.IsMembershipRequired,
        }
      : undefined,
    sections,
  };
}
