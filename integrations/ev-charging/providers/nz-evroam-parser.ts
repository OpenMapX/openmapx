import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { cleanString, connector, parseInteger, parseLocalizedNumber } from "./utils.js";

/**
 * NZ EVRoam (Waka Kotahi NZ Transport Agency) parser — ArcGIS FeatureServer
 * GeoJSON, single GET, static-only (~638 stations).
 *
 * The `connectorsList` property is NOT JSON — it's a free-text sequence of
 * brace-delimited groups, one per connector class:
 *   "{AC, 32 kW, Type 2 Socketed, Status: Operative, Count:9},{...}"
 * Each group is split positionally on comma into
 * [currentType, powerText, typeText, "Status: X", "Count:N"].
 *
 * Pre-migration id was not present upstream; `GlobalID` (falling back to
 * `OBJECTID`) is the only stable per-station identifier the feed provides.
 */

export const NZ_EVROAM_URL =
  "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/EV_Roam_charging_stations/FeatureServer/0/query?where=1=1&outFields=*&f=geojson&resultRecordCount=2000";

const SOURCE_URL =
  "https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::ev-roam-charging-stations";

const CONNECTOR_TYPE_MAP: Record<string, string> = {
  "Type 1 Tethered": "Type 1",
  "Type 1 CCS": "CCS (Type 2)",
  "Type 2 Socketed": "Type 2",
  "Type 2 Tethered": "Type 2",
  "Type 2 CCS": "CCS (Type 2)",
  CHAdeMO: "CHAdeMO",
};

interface NzEvroamFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

interface NzEvroamFeatureCollection {
  features?: NzEvroamFeature[];
}

interface ConnectorGroup {
  currentType?: string;
  powerKw?: number;
  type: string;
  status?: string;
  quantity?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseConnectorsList(value: string | undefined): ConnectorGroup[] {
  if (!value) return [];
  const groups: ConnectorGroup[] = [];
  for (const match of value.matchAll(/\{([^}]*)\}/g)) {
    const parts = match[1].split(",").map((part) => part.trim());
    const [currentTypeRaw, powerText, typeText, statusText, countText] = parts;
    groups.push({
      currentType: cleanString(currentTypeRaw),
      powerKw: parseLocalizedNumber(powerText),
      type: CONNECTOR_TYPE_MAP[typeText ?? ""] ?? "Unknown",
      status: cleanString(statusText?.split(":")[1]),
      quantity: parseInteger(countText?.split(":")[1]),
    });
  }
  return groups;
}

function rollupStatus(groups: ConnectorGroup[]): "operational" | "not-operational" | "unknown" {
  if (groups.length === 0) return "unknown";
  if (groups.some((g) => g.status === "Operative")) return "operational";
  if (groups.every((g) => g.status === "Inoperative")) return "not-operational";
  return "unknown";
}

function usageCost(hasChargingCost: unknown): string | undefined {
  if (hasChargingCost === "True") return "Paid";
  if (hasChargingCost === "False") return "Free";
  return undefined;
}

function openingHours(is24Hours: unknown): string | undefined {
  return is24Hours === "True" ? "24/7" : undefined;
}

function featureToPoi(feature: NzEvroamFeature): PoiRow | null {
  const props = feature.properties ?? {};
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (typeof lng !== "number" || typeof lat !== "number") return null;

  const poiId =
    str(props.GlobalID) ?? (props.OBJECTID !== undefined ? String(props.OBJECTID) : undefined);
  if (!poiId) return null;

  const connectorGroups = parseConnectorsList(str(props.connectorsList));
  const operatorName = cleanString(str(props.operator)) ?? cleanString(str(props.owner));

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: cleanString(str(props.name)) ?? "EV Charging Station",
      operator: operatorName ? { name: operatorName } : undefined,
      address: {
        line1: cleanString(str(props.address)),
        country: "New Zealand",
      },
      status: rollupStatus(connectorGroups),
      connectors: connectorGroups.map((g) =>
        connector({
          type: g.type,
          powerKw: g.powerKw,
          currentType: g.currentType,
          quantity: g.quantity,
        }),
      ),
      openingHours: openingHours(props.is24Hours),
      usageCost: usageCost(props.hasChargingCost),
      sourceUrl: SOURCE_URL,
    },
  };
}

export const parseNzEvroam: PoiStaticParseFn = (buffer) => {
  const text = buffer.toString("utf8");
  let data: NzEvroamFeatureCollection;
  try {
    data = JSON.parse(text) as NzEvroamFeatureCollection;
  } catch {
    return [];
  }
  const features = data?.features;
  if (!Array.isArray(features)) return [];

  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    const poi = featureToPoi(feature);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
