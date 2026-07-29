import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { XMLParser } from "fast-xml-parser";
import { cleanString, connector, stableHashId } from "./utils.js";

export const LU_CHARGY_URL =
  "https://data.public.lu/fr/datasets/r/22f9d77a-5138-4b02-b315-15f306b77034";

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface ChargyConnectorEntry {
  maxchspeed?: number;
  connector?: number;
  description?: string;
}

interface ChargyDeviceValue {
  id?: number;
  name?: string;
  numberOfConnectors?: number;
  connectors?: ChargyConnectorEntry[];
}

function parseCoordinates(raw: unknown): [number, number] | undefined {
  const text = cleanString(typeof raw === "string" ? raw : undefined);
  if (!text) return undefined;
  // KML is "lng,lat[,alt]" — already lng,lat order, do NOT swap like the
  // lat-first feeds (ES DGT, CY CYNAP) require.
  const [lngRaw, latRaw] = text.split(",");
  const lng = Number.parseFloat(lngRaw ?? "");
  const lat = Number.parseFloat(latRaw ?? "");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return [lng, lat];
}

// Chargy rolls every station up to a single AVAILABLE/UNAVAILABLE style —
// it isn't a "broken/out of service" signal, just "at least one connector is
// free" vs "none are". Map to operational/unknown rather than
// not-operational, which would overstate what the feed actually says.
function statusFromStyleUrl(styleUrl: unknown): "operational" | "unknown" {
  return styleUrl === "#AVAILABLE" ? "operational" : "unknown";
}

function parseChargingDeviceValue(raw: unknown): ChargyDeviceValue | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as ChargyDeviceValue;
  } catch {
    return undefined;
  }
}

function extendedDataConnectors(extendedData: unknown): EvChargingConnector[] {
  const dataNodes = asArray(
    (extendedData as Record<string, unknown> | undefined)?.Data as unknown,
  ) as Array<Record<string, unknown>>;

  const out: EvChargingConnector[] = [];
  for (const node of dataNodes) {
    if (node["@_name"] !== "chargingdevice") continue;
    const device = parseChargingDeviceValue(node.value);
    if (!device) continue;
    for (const conn of device.connectors ?? []) {
      const powerKw = typeof conn.maxchspeed === "number" ? conn.maxchspeed : undefined;
      // Chargy labels every physical connector "Type 2" regardless of rated
      // power, including 350-400kW HPC plugs that are clearly CCS/DC — the
      // label is only trustworthy at/under the AC ceiling (~43kW).
      const isAc = powerKw !== undefined && powerKw <= 43;
      out.push(
        connector({
          type: isAc ? "Type 2" : "Unknown",
          powerKw,
          currentType: isAc ? "AC" : "DC",
          quantity: 1,
        }),
      );
    }
  }
  return out;
}

function placemarkToPoi(placemark: Record<string, unknown>): PoiRow | null {
  const name = cleanString(typeof placemark.name === "string" ? placemark.name : undefined);
  const point = placemark.Point as Record<string, unknown> | undefined;
  const coords = parseCoordinates(point?.coordinates);
  if (!coords) return null;
  const [lng, lat] = coords;

  const poiId = stableHashId(name, lng, lat);
  const address = cleanString(
    typeof placemark.address === "string" ? placemark.address : undefined,
  );

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: name ?? "Chargy Charging Station",
      address: {
        line1: address,
        country: "Luxembourg",
      },
      operator: { name: "Chargy" },
      status: statusFromStyleUrl(placemark.styleUrl),
      connectors: extendedDataConnectors(placemark.ExtendedData),
      sourceUrl: LU_CHARGY_URL,
    },
  };
}

export const parseLuChargy: PoiStaticParseFn = (buffer) => {
  const text = buffer.toString("utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });
  const parsed = parser.parse(text) as Record<string, unknown>;
  const kml = parsed.kml as Record<string, unknown> | undefined;
  const document = kml?.Document as Record<string, unknown> | undefined;
  const placemarks = asArray(document?.Placemark as unknown) as Array<Record<string, unknown>>;

  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const placemark of placemarks) {
    const poi = placemarkToPoi(placemark);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
