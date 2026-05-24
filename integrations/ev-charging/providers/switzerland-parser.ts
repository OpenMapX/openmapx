import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { cleanString, connector, parseLocalizedNumber, uniqueStrings } from "./utils.js";

interface SwissEvseDataGroup {
  OperatorID?: string;
  OperatorName?: string;
  EVSEDataRecord?: SwissEvseRecord[];
}

interface SwissEvseFeed {
  EVSEData?: SwissEvseDataGroup[];
}

interface SwissAddress {
  Street?: string;
  City?: string;
  PostalCode?: string;
  Country?: string;
  Region?: string;
}

interface SwissChargingFacility {
  Amperage?: number;
  Voltage?: number;
  power?: number;
  powertype?: string;
}

interface SwissEvseRecord {
  Accessibility?: string;
  AccessibilityLocation?: string;
  Address?: SwissAddress;
  AuthenticationModes?: string[];
  ChargingFacilities?: SwissChargingFacility[];
  ChargingStationId?: string;
  ChargingStationNames?: Array<{ lang?: string; value?: string }>;
  DynamicInfoAvailable?: boolean;
  EvseID?: string;
  GeoCoordinates?: { Google?: string };
  HotlinePhoneNumber?: string;
  IsOpen24Hours?: boolean;
  Plugs?: string[];
  RenewableEnergy?: boolean;
  lastUpdate?: string;
}

const DATASET_URL = "https://opendata.swiss/en/dataset/ladestationen-fuer-elektroautos";

function parseGoogleCoordinates(value: string | undefined): [number, number] | null {
  const parts = value?.trim().split(/\s+/) ?? [];
  if (parts.length < 2) return null;
  const lat = parseLocalizedNumber(parts[0]);
  const lng = parseLocalizedNumber(parts[1]);
  if (lat === undefined || lng === undefined) return null;
  return [lng, lat];
}

function preferredName(record: SwissEvseRecord): string | undefined {
  const names = record.ChargingStationNames ?? [];
  return (
    cleanString(names.find((name) => name.lang === "en")?.value) ??
    cleanString(names.find((name) => name.lang === "de")?.value) ??
    cleanString(names.find((name) => name.lang === "fr")?.value) ??
    cleanString(names[0]?.value)
  );
}

function maxFacilityPower(record: SwissEvseRecord): number | undefined {
  const powers = (record.ChargingFacilities ?? [])
    .map((facility) => facility.power)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (powers.length > 0) return Math.max(...powers);

  const calculated = (record.ChargingFacilities ?? [])
    .map((facility) =>
      facility.Voltage && facility.Amperage ? (facility.Voltage * facility.Amperage) / 1000 : 0,
    )
    .filter((value) => value > 0);
  return calculated.length > 0 ? Math.max(...calculated) : undefined;
}

function recordConnectors(record: SwissEvseRecord): EvChargingConnector[] {
  const plugs = record.Plugs ?? [];
  const powerKw = maxFacilityPower(record);
  if (plugs.length === 0 && powerKw) {
    return [connector({ type: "Unknown", powerKw, reference: record.EvseID })];
  }
  return plugs.map((plug) => connector({ type: plug, powerKw, reference: record.EvseID }));
}

export function parseSwissOicp(buffer: Buffer): PoiRow[] {
  const feed = JSON.parse(buffer.toString("utf8")) as SwissEvseFeed;
  const rows: PoiRow[] = [];

  for (const group of feed.EVSEData ?? []) {
    const operatorName = cleanString(group.OperatorName) ?? cleanString(group.OperatorID);
    for (const record of group.EVSEDataRecord ?? []) {
      const coordinates = parseGoogleCoordinates(record.GeoCoordinates?.Google);
      const stationId = cleanString(record.ChargingStationId) ?? cleanString(record.EvseID);
      if (!coordinates || !stationId) continue;

      const encodedStationId = encodeURIComponent(stationId);
      const encodedEvseId = record.EvseID ? encodeURIComponent(record.EvseID) : undefined;

      const notes = [
        record.DynamicInfoAvailable ? "Dynamic status available" : undefined,
        record.RenewableEnergy ? "Renewable energy" : undefined,
        record.HotlinePhoneNumber ? `Hotline: ${record.HotlinePhoneNumber}` : undefined,
      ].filter((value): value is string => Boolean(value));

      const paymentMethods = uniqueStrings([record.AuthenticationModes]);

      rows.push({
        // Use the encoded station id as the bare poiId so the existing
        // user-facing id format (prefix + encoded id) is preserved by the
        // mapper. Decoupling station id from EvseID here means Phase C ships
        // static-only — per-EVSE live status returns later as a separate spec.
        poiId: encodedStationId,
        lng: coordinates[0],
        lat: coordinates[1],
        payload: {
          // Duplicated coordinates: the reader only returns (poiId, payload);
          // geom is consumed by the SQL bbox filter, not echoed back.
          coordinates,
          name: preferredName(record) ?? "EV Charging Station",
          encodedEvseId,
          address: {
            line1: cleanString(record.Address?.Street),
            town: cleanString(record.Address?.City),
            state: cleanString(record.Address?.Region),
            postcode: cleanString(record.Address?.PostalCode),
            country: cleanString(record.Address?.Country) ?? "Switzerland",
          },
          operator: operatorName ? { name: operatorName } : undefined,
          usageType: cleanString(record.Accessibility),
          openingHours: record.IsOpen24Hours ? "24/7" : undefined,
          access: cleanString(record.AccessibilityLocation),
          paymentMethods,
          connectors: recordConnectors(record),
          updatedAt: cleanString(record.lastUpdate),
          sourceUrl: DATASET_URL,
          notes: notes.length > 0 ? notes : undefined,
        },
      });
    }
  }

  return rows;
}
