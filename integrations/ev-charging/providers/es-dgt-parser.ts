import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import { assertNoXmlEntityDeclarations } from "@openmapx/mobility-formats";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { XMLParser } from "fast-xml-parser";
import { cleanString, connector, parseLocalizedNumber } from "./utils.js";

export const ES_DGT_URL =
  "https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml";
const SOURCE_URL = "https://nap.dgt.es/en/dataset/puntos-de-recarga-electrica-para-vehiculos";

// DATEX II serialises a lone repeated child as a bare object rather than a
// one-element array (fast-xml-parser mirrors the XML shape 1:1), so every
// place this feed *can* repeat (sites, stations, refill points, connectors,
// address lines, localized name values) has to be normalised through this
// helper before iterating.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const CONNECTOR_TYPE_MAP: Record<string, string> = {
  iec62196T2: "Type 2",
  iec62196T2COMBO: "CCS (Type 2)",
  chademo: "CHAdeMO",
  iec62196T1: "Type 1",
};

// The Spanish address labels ("Dirección:", "Municipio:", "Provincia:",
// "Comunidad Autónoma:") are baked into the free-text value itself — strip
// them so `address.line1`/`town`/`state` hold just the place name.
const ADDRESS_LABEL_RE = /^(Dirección|Municipio|Provincia|Comunidad Autónoma)\s*:\s*/i;

function stripAddressLabel(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  return cleanString(cleaned.replace(ADDRESS_LABEL_RE, ""));
}

// Localized `values/value` blocks may carry several `<value lang="...">`
// entries; prefer Spanish (the feed's native `lang="es"` publication
// language) but fall back to whatever is first when "es" isn't present.
function localizedValue(values: unknown): string | undefined {
  if (!values || typeof values !== "object") return undefined;
  const entries = asArray((values as { value?: unknown }).value) as Array<
    { "#text"?: unknown; "@_lang"?: unknown } | string
  >;
  if (entries.length === 0) return undefined;
  const es = entries.find((entry) => typeof entry === "object" && entry["@_lang"] === "es");
  const chosen = es ?? entries[0];
  if (typeof chosen === "string") return cleanString(chosen);
  return cleanString(chosen?.["#text"] as string | undefined);
}

function siteName(site: Record<string, unknown>): string | undefined {
  const name = site.name as { values?: unknown } | undefined;
  return localizedValue(name?.values);
}

function siteOperator(site: Record<string, unknown>): { name: string } | undefined {
  const operator = site.operator as { name?: { values?: unknown } } | undefined;
  const name = localizedValue(operator?.name?.values);
  return name ? { name } : undefined;
}

interface EsDgtAddress {
  line1?: string;
  town?: string;
  state?: string;
  postcode?: string;
  country: string;
}

function siteAddress(site: Record<string, unknown>): EsDgtAddress | undefined {
  const locationReference = site.locationReference as
    | { _locationReferenceExtension?: { facilityLocation?: { address?: Record<string, unknown> } } }
    | undefined;
  const address = locationReference?._locationReferenceExtension?.facilityLocation?.address;
  if (!address) return undefined;

  const lines = asArray(
    address.addressLine as
      | Array<{ "@_order"?: string | number; text?: { values?: unknown } }>
      | undefined,
  );
  const byOrder = new Map<number, string | undefined>();
  for (const line of lines) {
    const order = Number(line["@_order"]);
    if (!Number.isFinite(order)) continue;
    byOrder.set(order, stripAddressLabel(localizedValue(line.text?.values)));
  }

  // fast-xml-parser auto-coerces a numeric-looking postcode ("7006") to a
  // JS number, so stringify before cleaning rather than dropping it.
  const rawPostcode = address.postcode;
  const postcode = cleanString(
    typeof rawPostcode === "number" ? String(rawPostcode) : (rawPostcode as string | undefined),
  );
  const line1 = byOrder.get(1);
  const town = byOrder.get(2);
  const state = byOrder.get(4) ?? byOrder.get(3);

  if (!line1 && !town && !state && !postcode) return undefined;
  return { line1, town, state, postcode, country: "Spain" };
}

function siteCoordinates(site: Record<string, unknown>): [number, number] | undefined {
  const locationReference = site.locationReference as
    | { coordinatesForDisplay?: { latitude?: unknown; longitude?: unknown } }
    | undefined;
  const coords = locationReference?.coordinatesForDisplay;
  const lat = parseLocalizedNumber(coords?.latitude);
  const lng = parseLocalizedNumber(coords?.longitude);
  if (lat === undefined || lng === undefined) return undefined;
  // DATEX gives latitude before longitude — swap to [lng, lat].
  return [lng, lat];
}

function connectorType(rawType: string | undefined): string {
  if (!rawType) return "Unknown";
  return CONNECTOR_TYPE_MAP[rawType] ?? "Unknown";
}

function connectorCurrentType(chargingMode: string | undefined): "AC" | "DC" {
  return typeof chargingMode === "string" && chargingMode.toLowerCase().startsWith("mode4")
    ? "DC"
    : "AC";
}

function siteConnectors(site: Record<string, unknown>): EvChargingConnector[] {
  const stations = asArray(
    site.energyInfrastructureStation as Record<string, unknown>[] | undefined,
  );
  const connectors: EvChargingConnector[] = [];
  for (const station of stations) {
    const refillPoints = asArray(station.refillPoint as Record<string, unknown>[] | undefined);
    for (const refillPoint of refillPoints) {
      const rawConnectors = asArray(
        refillPoint.connector as
          | Array<{
              connectorType?: string;
              chargingMode?: string;
              maxPowerAtSocket?: unknown;
            }>
          | undefined,
      );
      for (const raw of rawConnectors) {
        // Feed publishes power in watts — convert to kW.
        const watts = parseLocalizedNumber(raw.maxPowerAtSocket);
        connectors.push(
          connector({
            type: connectorType(raw.connectorType),
            powerKw: watts !== undefined ? watts / 1000 : undefined,
            currentType: connectorCurrentType(raw.chargingMode),
            quantity: 1,
          }),
        );
      }
    }
  }
  return connectors;
}

function siteToRow(site: Record<string, unknown>): PoiRow | null {
  const poiId = cleanString(site["@_id"] as string | undefined);
  if (!poiId) return null;
  const coordinates = siteCoordinates(site);
  if (!coordinates) return null;

  return {
    poiId,
    lng: coordinates[0],
    lat: coordinates[1],
    payload: {
      coordinates,
      name: siteName(site) ?? "EV Charging Station",
      address: siteAddress(site),
      operator: siteOperator(site),
      status: "unknown",
      connectors: siteConnectors(site),
      updatedAt: cleanString(site.lastUpdated as string | undefined),
      sourceUrl: SOURCE_URL,
    },
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

export const parseEsDgt: PoiStaticParseFn = function* (buffer) {
  const text = buffer.toString("utf8");
  assertNoXmlEntityDeclarations(text);
  const doc = parser.parse(text) as {
    payload?: {
      energyInfrastructureTable?: {
        energyInfrastructureSite?: Record<string, unknown>[] | Record<string, unknown>;
      };
    };
  };
  const sites = asArray(doc.payload?.energyInfrastructureTable?.energyInfrastructureSite);

  const seen = new Set<string>();
  for (const site of sites) {
    const row = siteToRow(site);
    if (!row || seen.has(row.poiId)) continue;
    seen.add(row.poiId);
    yield row;
  }
};
