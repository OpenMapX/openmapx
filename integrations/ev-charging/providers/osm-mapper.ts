import type { DataSourceDetail, DataSourceResult } from "@openmapx/core";
import { formatAddress } from "@openmapx/integration-geocoding/format-address";
import type { OsmChargingStation } from "./osm.js";
import { mapStationToDetail, mapStationToResult } from "./station-mapper.js";
import type { EvChargingConnector, EvChargingStation } from "./types.js";
import { connector, parseLocalizedNumber } from "./utils.js";

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

function inferStatus(tags: Record<string, string>): EvChargingStation["status"] {
  if (tags["disused:amenity"] === "charging_station" || tags.disused === "yes") {
    return "not-operational";
  }
  if (tags.proposed === "yes" || tags.construction === "yes") return "planned";
  return "operational";
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

function getOutputPower(tags: Record<string, string>, tagKey?: string): number | undefined {
  if (tagKey) {
    const specific = parseLocalizedNumber(tags[`${tagKey}:output`]);
    if (specific) return specific;
  }
  return parseLocalizedNumber(tags["charging_station:output"] ?? tags.output);
}

function getPaymentMethods(tags: Record<string, string>): string[] | undefined {
  const methods = Object.entries(tags)
    .filter(([key, value]) => key.startsWith("payment:") && value !== "no" && value !== "0")
    .map(([key]) => key.slice("payment:".length).replace(/_/g, " "));
  return methods.length > 0 ? methods : undefined;
}

function getConnectors(tags: Record<string, string>): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];
  for (const [tagKey, label] of Object.entries(SOCKET_TAG_MAP)) {
    const value = tags[tagKey];
    if (!value || value === "no" || value === "0") continue;
    const qty = Number.parseInt(value, 10);
    connectors.push(
      connector({
        type: label,
        powerKw: getOutputPower(tags, tagKey),
        quantity: Number.isNaN(qty) ? 1 : qty,
      }),
    );
  }
  return connectors;
}

export function mapOsmToStation(station: OsmChargingStation): EvChargingStation {
  const name = station.tags.name || station.tags.operator || "EV Charging Station";

  return {
    id: `osm:${station.id}`,
    sources: ["osm"],
    sourceItemIds: [`osm:${station.id}`],
    name,
    coordinates: [station.lon, station.lat],
    address: {
      line1: station.tags["addr:street"]
        ? formatAddress(
            {
              road: station.tags["addr:street"],
              house_number: station.tags["addr:housenumber"],
              country_code: station.tags["addr:country"]?.toLowerCase(),
            },
            { appendCountry: false },
          )
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
    status: inferStatus(station.tags),
    usageType: station.tags.access ?? "Public",
    usageCost: station.tags.fee === "no" ? "Free" : station.tags.charge,
    openingHours: station.tags.opening_hours,
    access: station.tags.description ?? station.tags.note,
    paymentMethods: getPaymentMethods(station.tags),
    connectors: getConnectors(station.tags),
    osmTags: station.tags,
  };
}

export function mapOsmToDetail(station: OsmChargingStation): DataSourceDetail {
  return mapStationToDetail(mapOsmToStation(station));
}

export function mapOsmToResult(station: OsmChargingStation): DataSourceResult {
  return {
    ...mapStationToResult(mapOsmToStation(station)),
    variant: inferVariant(station.tags),
    summary: buildOsmSummary(station.tags),
  };
}
