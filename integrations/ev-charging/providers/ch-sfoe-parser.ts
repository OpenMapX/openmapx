import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger } from "@openmapx/poi-source-registry";
import {
  bboxContainsCoordinates,
  cleanString,
  connector,
  parseLocalizedNumber,
  uniqueStrings,
} from "./utils.js";

interface ChSfoeEvseDataGroup {
  OperatorID?: string;
  OperatorName?: string;
  EVSEDataRecord?: ChSfoeEvseRecord[];
}

interface ChSfoeEvseFeed {
  EVSEData?: ChSfoeEvseDataGroup[];
}

interface ChSfoeAddress {
  Street?: string;
  City?: string;
  PostalCode?: string;
  Country?: string;
  Region?: string;
}

interface ChSfoeChargingFacility {
  Amperage?: number;
  Voltage?: number;
  power?: number;
  powertype?: string;
}

interface ChSfoeEvseRecord {
  Accessibility?: string;
  AccessibilityLocation?: string;
  Address?: ChSfoeAddress;
  AuthenticationModes?: string[];
  ChargingFacilities?: ChSfoeChargingFacility[];
  ChargingStationId?: string;
  ChargingStationNames?:
    | Array<{ lang?: string; value?: string }>
    | { lang?: string; value?: string };
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

// The OICP feed carries a handful of records with unusable coordinates — mostly
// operator placeholders (mid-Atlantic sentinel "50.0 -15.0", null-island "0.0
// 0.0") but also a few real stations sitting abroad (Malta, Germany, …) that
// don't belong in a Swiss source. They inflate the dataset's geographic extent
// and plot Swiss chargers on the wrong continent, so drop anything outside
// Switzerland (matches the reader coverage box in ch-sfoe.ts).
const CH_BOUNDS = { west: 5.9, south: 45.8, east: 10.6, north: 47.9 };

function parseGoogleCoordinates(value: string | undefined): [number, number] | null {
  const parts = value?.trim().split(/\s+/) ?? [];
  if (parts.length < 2) return null;
  const lat = parseLocalizedNumber(parts[0]);
  const lng = parseLocalizedNumber(parts[1]);
  if (lat === undefined || lng === undefined) return null;
  return [lng, lat];
}

function preferredName(record: ChSfoeEvseRecord): string | undefined {
  // OICP serialises a single-element list as a bare object, not a 1-element
  // array (~40 of ~19k CH records), so normalise before iterating.
  const raw = record.ChargingStationNames;
  const names = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (
    cleanString(names.find((name) => name.lang === "en")?.value) ??
    cleanString(names.find((name) => name.lang === "de")?.value) ??
    cleanString(names.find((name) => name.lang === "fr")?.value) ??
    cleanString(names[0]?.value)
  );
}

function maxFacilityPower(record: ChSfoeEvseRecord): number | undefined {
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

function recordConnectors(record: ChSfoeEvseRecord): EvChargingConnector[] {
  const plugs = record.Plugs ?? [];
  const powerKw = maxFacilityPower(record);
  if (plugs.length === 0 && powerKw) {
    return [connector({ type: "Unknown", powerKw, reference: record.EvseID })];
  }
  return plugs.map((plug) => connector({ type: plug, powerKw, reference: record.EvseID }));
}

export function parseChSfoeOicp(buffer: Buffer, ctx?: { log?: PoiSourceLogger }): PoiRow[] {
  const log = ctx?.log;
  const feed = JSON.parse(buffer.toString("utf8")) as ChSfoeEvseFeed;
  // OICP emits one record per EVSE, and multiple EVSEs of the same station
  // share a ChargingStationId. Collapse to one row per station (the poiId),
  // merging each EVSE's connectors — otherwise duplicate poiIds violate the
  // static table's primary key.
  const byStation = new Map<string, PoiRow>();
  let outOfBounds = 0;

  for (const group of feed.EVSEData ?? []) {
    const operatorName = cleanString(group.OperatorName) ?? cleanString(group.OperatorID);
    for (const record of group.EVSEDataRecord ?? []) {
      const coordinates = parseGoogleCoordinates(record.GeoCoordinates?.Google);
      const stationId = cleanString(record.ChargingStationId) ?? cleanString(record.EvseID);
      if (!coordinates || !stationId) continue;
      if (!bboxContainsCoordinates(CH_BOUNDS, coordinates)) {
        outOfBounds += 1;
        continue;
      }

      const encodedStationId = encodeURIComponent(stationId);
      const encodedEvseId = record.EvseID ? encodeURIComponent(record.EvseID) : undefined;

      const existing = byStation.get(encodedStationId);
      if (existing) {
        const merged = existing.payload.connectors as ReturnType<typeof recordConnectors>;
        existing.payload.connectors = [...merged, ...recordConnectors(record)];
        continue;
      }

      const notes = [
        record.DynamicInfoAvailable ? "Dynamic status available" : undefined,
        record.RenewableEnergy ? "Renewable energy" : undefined,
        record.HotlinePhoneNumber ? `Hotline: ${record.HotlinePhoneNumber}` : undefined,
      ].filter((value): value is string => Boolean(value));

      const paymentMethods = uniqueStrings([record.AuthenticationModes]);

      byStation.set(encodedStationId, {
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
          // Extra source-native id(s) the shared payload mapper appends to
          // sourceItemIds (prefixed) — here the EVSE id, so a station is also
          // matchable by its EVSE id. Was `encodedEvseId` pre-migration.
          extraItemIds: encodedEvseId ? [encodedEvseId] : undefined,
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

  if (outOfBounds > 0) {
    log?.warn(`ch-sfoe: dropped ${outOfBounds} record(s) with coordinates outside Switzerland`);
  }

  return Array.from(byStation.values());
}
