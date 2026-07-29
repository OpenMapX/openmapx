import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { XMLParser } from "fast-xml-parser";
import { cleanString, connector, parseLocalizedNumber } from "./utils.js";

// NAP Slovenija (National Access Point) — Prometej IDACS "Energy
// Infrastructure Table" dataset, DATEX II v3.6. Confirmed against the
// dataset's own published sample (nap.si dataset code viewer for dataset id
// 46963663-38dd-eb04-43a9-cca9bdc0e4ba); the fixture in
// __tests__/fixtures/si-nap.xml is three real sites trimmed out of that
// sample verbatim. Access requires OAuth2 bearer auth — see si-nap.ts.
export const SI_NAP_URL =
  "https://b2b.nap.si/data/b2b.prometej.energyInfrastructureTablePublication";
const SOURCE_URL = "https://www.nap.si/en/datasets_details?id=46963663-38dd-eb04-43a9-cca9bdc0e4ba";

// Unlike the Spanish DGT feed (`<d2:payload><egi:energyInfrastructureTable>`),
// NAP Slovenija's DATEX II root element IS the
// `EnergyInfrastructureTablePublication` itself (no payload wrapper) — see
// the dataset's published sample. A lone repeated child still serialises as
// a bare object rather than a one-element array (fast-xml-parser mirrors the
// XML shape 1:1), so every place this feed *can* repeat has to go through
// this helper before iterating — same as the ES DGT parser.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// DATEX II `connectorType` codes observed in the published sample, mapped to
// the same human labels the other national feeds use. `chademo` and the CCS
// combo type are the only DC-capable types in this feed — everything else
// (Type 2 without combo, and the "domestic" household-socket types) charges
// over IEC 62196 Mode 2/3, which is AC-only.
const CONNECTOR_TYPE_MAP: Record<string, string> = {
  iec62196T2: "Type 2",
  iec62196T2COMBO: "CCS (Type 2)",
  chademo: "CHAdeMO",
  domesticF: "Schuko",
  domesticG: "Domestic (Type G)",
  domesticB: "Domestic (Type B)",
};

// Localized `values/value` blocks may carry several `<value lang="...">`
// entries; the feed's native publication language is Slovenian
// (`lang="sl"` on the root element) so prefer that, falling back to
// whatever is first when "sl" isn't present.
function localizedValue(values: unknown): string | undefined {
  if (!values || typeof values !== "object") return undefined;
  const entries = asArray((values as { value?: unknown }).value) as Array<
    { "#text"?: unknown; "@_lang"?: unknown } | string
  >;
  if (entries.length === 0) return undefined;
  const sl = entries.find((entry) => typeof entry === "object" && entry["@_lang"] === "sl");
  const chosen = sl ?? entries[0];
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

interface SiNapAddress {
  line1?: string;
  town?: string;
  postcode?: string;
  country: string;
}

function siteAddress(site: Record<string, unknown>): SiNapAddress | undefined {
  const locationReference = site.locationReference as
    | { _locationReferenceExtension?: { facilityLocation?: { address?: Record<string, unknown> } } }
    | undefined;
  const address = locationReference?._locationReferenceExtension?.facilityLocation?.address;
  if (!address) return undefined;

  const lines = asArray(
    address.addressLine as
      | Array<{ text?: { values?: unknown } }>
      | { text?: { values?: unknown } }
      | undefined,
  );
  // Every observed site carries a single street-level address line (no
  // Spanish-style municipality/province split across multiple lines).
  const line1 = localizedValue(lines[0]?.text?.values);
  const town = localizedValue((address.city as { values?: unknown } | undefined)?.values);

  // fast-xml-parser auto-coerces a numeric-looking postcode to a JS number
  // (same quirk as the ES DGT feed), so stringify before cleaning.
  const rawPostcode = address.postcode;
  const postcode = cleanString(
    typeof rawPostcode === "number" ? String(rawPostcode) : (rawPostcode as string | undefined),
  );

  if (!line1 && !town && !postcode) return undefined;
  return { line1, town, postcode, country: "Slovenia" };
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

// The feed has no `chargingMode` field (unlike ES DGT) — DC-capability is
// implied entirely by `connectorType`: CHAdeMO and CCS combo are DC fast
// chargers, every other type in this feed (Type 2, and the household
// "domestic*" socket types) is IEC 62196 Mode 2/3 AC-only.
function connectorCurrentType(rawType: string | undefined): "AC" | "DC" {
  return rawType === "chademo" || rawType === "iec62196T2COMBO" ? "DC" : "AC";
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
          | Array<{ connectorType?: string; maxPowerAtSocket?: unknown }>
          | undefined,
      );
      for (const raw of rawConnectors) {
        // Feed publishes power in watts — convert to kW. A handful of rows
        // in the published sample carry a nonsensical negative wattage;
        // drop those rather than surface a negative powerKw.
        const watts = parseLocalizedNumber(raw.maxPowerAtSocket);
        connectors.push(
          connector({
            type: connectorType(raw.connectorType),
            powerKw: watts !== undefined && watts > 0 ? watts / 1000 : undefined,
            currentType: connectorCurrentType(raw.connectorType),
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
      sourceUrl: SOURCE_URL,
    },
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

export const parseSiNap: PoiStaticParseFn = function* (buffer) {
  const doc = parser.parse(buffer.toString("utf8")) as {
    EnergyInfrastructureTablePublication?: {
      energyInfrastructureTable?: {
        energyInfrastructureSite?: Record<string, unknown>[] | Record<string, unknown>;
      };
    };
  };
  const sites = asArray(
    doc.EnergyInfrastructureTablePublication?.energyInfrastructureTable?.energyInfrastructureSite,
  );

  const seen = new Set<string>();
  for (const site of sites) {
    const row = siteToRow(site);
    if (!row || seen.has(row.poiId)) continue;
    seen.add(row.poiId);
    yield row;
  }
};
