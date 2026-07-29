import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { XMLParser } from "fast-xml-parser";
import {
  cleanString,
  connector,
  parseInteger,
  parseLocalizedNumber,
  stableHashId,
} from "./utils.js";

export const CY_CYNAP_URL =
  "https://fixcyprus.cy/gnosis/open/api/nap/datasets/electric_vehicle_chargers/";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

// The CYNAP DATEX II profile has no attributes/text-value split like the
// Spanish DGT feed's com:value wrapper — leaf fields carry the text directly
// (e.g. chargingPointIdentification), while a few nested elements (address,
// status, operatingTime) wrap a "value" child alongside a "lang" sibling.
interface CyCynapValueLang {
  value?: unknown;
  lang?: string;
}

interface CyCynapChargingPoint {
  chargingPointIdentification?: unknown;
  chargingPointOwner?: unknown;
  chargingPointOperator?: unknown;
  chargingPointStatus?: CyCynapValueLang;
  numberOfConnectors?: unknown;
  location?: {
    pointByCoordinates?: {
      pointCoordinates?: {
        latitude?: unknown;
        longitude?: unknown;
      };
    };
  };
  maximumPower?: unknown;
  powerType?: unknown;
  connectorTypes?: {
    connectorType?: unknown;
  };
  chargingPointAddress?: CyCynapValueLang;
  operatingTime?: CyCynapValueLang;
  creationDate?: unknown;
}

// fast-xml-parser gives a bare value for a single child, an array for
// repeated children — normalise both to an array so callers never special-case.
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return cleanString(value);
  if (typeof value === "number") return String(value);
  return undefined;
}

function nestedValue(value: CyCynapValueLang | undefined): string | undefined {
  return textValue(value?.value);
}

function mapStatus(value: string | undefined): "operational" | "not-operational" | "unknown" {
  const lower = value?.toLowerCase();
  if (lower === "operational") return "operational";
  if (lower === "unavailable") return "not-operational";
  return "unknown";
}

const CONNECTOR_TYPE_MAP: Record<string, string> = {
  type2: "Type 2",
  combotype2: "CCS (Type 2)",
  chademo: "CHAdeMO",
};

function mapConnectorType(value: string | undefined): string {
  const key = value?.toLowerCase();
  return (key && CONNECTOR_TYPE_MAP[key]) ?? "Unknown";
}

function mapCurrentType(value: string | undefined): "AC" | "DC" | undefined {
  const lower = value?.toLowerCase();
  if (lower === "ac") return "AC";
  if (lower === "dc") return "DC";
  return undefined;
}

function pointConnectors(point: CyCynapChargingPoint): EvChargingConnector[] {
  const powerKw = parseLocalizedNumber(point.maximumPower);
  const currentType = mapCurrentType(textValue(point.powerType));
  const quantity = parseInteger(point.numberOfConnectors);
  const types = asArray(point.connectorTypes?.connectorType).map((value) => textValue(value));
  return types.map((rawType) =>
    connector({
      type: mapConnectorType(rawType),
      powerKw,
      currentType,
      quantity,
    }),
  );
}

function pointToPoi(point: CyCynapChargingPoint): PoiRow | null {
  const coords = point.location?.pointByCoordinates?.pointCoordinates;
  // Source gives latitude before longitude — swap to canonical [lng, lat].
  const lat = parseLocalizedNumber(coords?.latitude);
  const lng = parseLocalizedNumber(coords?.longitude);
  if (lat === undefined || lng === undefined) return null;

  const name = textValue(point.chargingPointIdentification) ?? "EV Charging Station";
  const poiId = stableHashId(name, lat, lng);

  const operatorName =
    cleanString(textValue(point.chargingPointOperator)) ??
    cleanString(textValue(point.chargingPointOwner));

  const addressLine = nestedValue(point.chargingPointAddress);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name,
      address: addressLine ? { line1: addressLine, country: "Cyprus" } : { country: "Cyprus" },
      operator: operatorName ? { name: operatorName } : undefined,
      status: mapStatus(nestedValue(point.chargingPointStatus)),
      connectors: pointConnectors(point),
      openingHours: nestedValue(point.operatingTime),
      updatedAt: textValue(point.creationDate),
      sourceUrl: CY_CYNAP_URL,
    },
  };
}

export const parseCyCynap: PoiStaticParseFn = (buffer) => {
  const text = buffer.toString("utf8");
  const doc = parser.parse(text) as {
    d2LogicalModel?: {
      payload?: {
        energyInfrastructureTable?: {
          energyInfrastructureTablePublication?: {
            chargingPoints?: {
              chargingPoint?: CyCynapChargingPoint | CyCynapChargingPoint[];
            };
          };
        };
      };
    };
  };

  const points = asArray(
    doc.d2LogicalModel?.payload?.energyInfrastructureTable?.energyInfrastructureTablePublication
      ?.chargingPoints?.chargingPoint,
  );

  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const poi = pointToPoi(point);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
