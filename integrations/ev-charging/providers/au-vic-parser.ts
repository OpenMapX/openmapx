import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { cleanString, connector, stableHashId } from "./utils.js";

const SOURCE_URL = "https://opendata.maps.vic.gov.au/geoserver/wfs";

interface VicFeature {
  id?: string;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
}

interface VicFeatureCollection {
  features?: VicFeature[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? cleanString(value) : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function coordinatesFromFeature(feature: VicFeature): [number, number] | undefined {
  const geomCoords = feature.geometry?.coordinates;
  if (Array.isArray(geomCoords)) {
    const lng = num(geomCoords[0]);
    const lat = num(geomCoords[1]);
    if (lng !== undefined && lat !== undefined) return [lng, lat];
  }
  // Fall back to the flat latitude/longitude properties when geometry is
  // missing or malformed — both are WGS84 decimal degrees in this feed.
  const props = feature.properties ?? {};
  const lat = num(props.latitude);
  const lng = num(props.longitude);
  if (lat !== undefined && lng !== undefined) return [lng, lat];
  return undefined;
}

/**
 * `estimated_project_completion` is free text ("November 2023", "10/10/2022",
 * a leading-space " July 2025", or blank/null for already-built sites). A
 * site is only "planned" when that date is genuinely in the future relative
 * to now; anything unparsable or in the past is treated as already built.
 */
function statusFromCompletion(value: unknown): "operational" | "planned" {
  const cleaned = str(value);
  if (!cleaned) return "operational";
  const parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) return "operational";
  return parsed > Date.now() ? "planned" : "operational";
}

const CONNECTOR_TYPE_MAP: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /ccs|combo/i, type: "CCS (Type 2)" },
  { pattern: /chademo/i, type: "CHAdeMO" },
  { pattern: /type\s*2/i, type: "Type 2" },
];

function connectorTypeFromToken(rawType: string): string {
  for (const { pattern, type } of CONNECTOR_TYPE_MAP) {
    if (pattern.test(rawType)) return type;
  }
  return "Unknown";
}

/**
 * Parses free-text plug_type strings like "1 x CCS2, 1 x CHAdeMO" or
 * "4 x CHAdeMO and 4 x CCS2/SAE" into connector rows. Tokens are separated by
 * "," or the word "and"; each token is "<quantity> x <type>".
 */
function parsePlugType(value: unknown): EvChargingConnector[] {
  const cleaned = str(value);
  if (!cleaned) return [];
  const tokens = cleaned
    .split(/,|\band\b/i)
    .map((token) => token.trim())
    .filter(Boolean);

  const connectors: EvChargingConnector[] = [];
  for (const token of tokens) {
    const match = token.match(/^(\d+)\s*x\s*(.+)$/i);
    if (!match) continue;
    const quantity = Number.parseInt(match[1], 10);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    connectors.push(connector({ type: connectorTypeFromToken(match[2]), quantity }));
  }
  return connectors;
}

function rowToPoi(feature: VicFeature): PoiRow | null {
  const coordinates = coordinatesFromFeature(feature);
  if (!coordinates) return null;
  const [lng, lat] = coordinates;

  const props = feature.properties ?? {};
  const location = str(props.location);
  const address = str(props.address);
  const poiId = cleanString(feature.id) ?? stableHashId(location, address, lat, lng);
  const operatorName = str(props.company) ?? str(props.lead_organisation);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates,
      name: location ?? "EV Charging Station",
      address: {
        line1: address,
        town: str(props.region),
        country: "Australia",
      },
      operator: operatorName ? { name: operatorName } : undefined,
      status: statusFromCompletion(props.estimated_project_completion),
      connectors: parsePlugType(props.plug_type),
      sourceUrl: SOURCE_URL,
    },
  };
}

export const parseAuVic: PoiStaticParseFn = (buffer) => {
  const data = JSON.parse(buffer.toString("utf8")) as VicFeatureCollection;
  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const feature of data.features ?? []) {
    const poi = rowToPoi(feature);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
