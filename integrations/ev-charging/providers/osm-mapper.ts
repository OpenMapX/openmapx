import type { DataSourceDetail, DataSourceResult } from "@openmapx/core";
import type { OsmChargingStation } from "./osm.js";

/** Maps OSM socket:* tags to human-readable connector labels. */
const SOCKET_TAG_MAP: Record<string, string> = {
  "socket:type2": "Type 2",
  "socket:type2_combo": "CCS",
  "socket:chademo": "CHAdeMO",
  "socket:type1": "Type 1",
  "socket:type1_combo": "CCS (Type 1)",
  "socket:tesla_standard": "Tesla",
  "socket:tesla_supercharger": "Tesla Supercharger",
  "socket:schuko": "Schuko",
  "socket:cee_blue": "CEE Blue",
  "socket:cee_red": "CEE Red",
};

/** Fast-charge connector tag names that imply DC fast charging. */
const FAST_CHARGE_TAGS = new Set([
  "socket:type2_combo",
  "socket:chademo",
  "socket:type1_combo",
  "socket:tesla_supercharger",
]);

function getConnectorLabels(tags: Record<string, string>): string[] {
  const labels: string[] = [];
  for (const [tagKey, label] of Object.entries(SOCKET_TAG_MAP)) {
    const value = tags[tagKey];
    if (value && value !== "no" && value !== "0") {
      labels.push(label);
    }
  }
  return labels;
}

function inferVariant(tags: Record<string, string>): string {
  // Check if any fast-charge socket tags are present
  for (const tag of FAST_CHARGE_TAGS) {
    const value = tags[tag];
    if (value && value !== "no" && value !== "0") {
      return "fast";
    }
  }

  // Check explicit capacity tag
  const capacity = tags["charging_station:output"];
  if (capacity) {
    const kw = Number.parseFloat(capacity);
    if (!Number.isNaN(kw)) {
      if (kw <= 22) return "slow";
      if (kw <= 100) return "fast";
      return "ultra-rapid";
    }
  }

  // If only AC sockets are present, it's slow
  const hasAnySocket = Object.keys(tags).some(
    (k) => k.startsWith("socket:") && tags[k] !== "no" && tags[k] !== "0",
  );
  if (hasAnySocket) return "slow";

  return "unknown";
}

function buildOsmSummary(tags: Record<string, string>): string {
  const parts: string[] = [];

  const connectors = getConnectorLabels(tags);
  if (connectors.length > 0) {
    parts.push(connectors.join(", "));
  }

  const capacity = tags.capacity;
  if (capacity) {
    parts.push(`${capacity} points`);
  }

  const operator = tags.operator || tags.network;
  if (operator) {
    parts.push(operator);
  }

  return parts.join(" \u00B7 ");
}

export function mapOsmToDetail(station: OsmChargingStation): DataSourceDetail {
  const name = station.tags.name || station.tags.operator || "EV Charging Station";

  // Build connector rows from socket tags with quantities
  const connectorRows: (string | number)[][] = [];
  for (const [tagKey, label] of Object.entries(SOCKET_TAG_MAP)) {
    const value = station.tags[tagKey];
    if (value && value !== "no" && value !== "0") {
      const qty = Number.parseInt(value, 10);
      connectorRows.push([label, "—", Number.isNaN(qty) ? 1 : qty, "Available"]);
    }
  }

  return {
    id: `osm:${station.id}`,
    source: "osm-ev",
    name,
    coordinates: [station.lon, station.lat],
    address: {
      line1: station.tags["addr:street"]
        ? `${station.tags["addr:housenumber"] ?? ""} ${station.tags["addr:street"]}`.trim()
        : undefined,
      town: station.tags["addr:city"],
      postcode: station.tags["addr:postcode"],
      country: station.tags["addr:country"],
    },
    operator: station.tags.operator
      ? {
          name: station.tags.operator,
          url: station.tags["contact:website"] || station.tags.website,
        }
      : undefined,
    usageInfo: station.tags.fee
      ? {
          type: station.tags.access ?? "Public",
          cost: station.tags.fee === "no" ? "Free" : (station.tags.charge ?? "Paid"),
        }
      : undefined,
    attribution: {
      text: "OpenStreetMap contributors",
      url: "https://www.openstreetmap.org",
      license: "ODbL",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    },
    sections:
      connectorRows.length > 0
        ? [
            {
              title: "Connectors",
              type: "table" as const,
              columns: ["Type", "Power", "Qty", "Status"],
              rows: connectorRows,
            },
          ]
        : [],
    osmTags: station.tags,
  };
}

export function mapOsmToResult(station: OsmChargingStation): DataSourceResult {
  const name = station.tags.name || station.tags.operator || "Charging Station";

  return {
    id: `osm:${station.id}`,
    name,
    coordinates: [station.lon, station.lat],
    source: "osm-ev",
    variant: inferVariant(station.tags),
    status:
      station.tags["disused:amenity"] === "charging_station" ? "not-operational" : "operational",
    summary: buildOsmSummary(station.tags),
    operator: station.tags.operator || station.tags.network,
  };
}
