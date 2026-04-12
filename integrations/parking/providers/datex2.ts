/**
 * Shared Datex II XML parsing utilities for parking data.
 *
 * Handles both Datex II v2 (e.g. NDW static table) and v3 (e.g. NDW dynamic status).
 * Uses fast-xml-parser with namespace prefix removal for clean element access.
 */

import { XMLParser } from "fast-xml-parser";

export interface Datex2ParkingRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  freeOfCharge?: boolean;
  totalSpaces?: number;
  equipmentTypes?: string[];
}

export interface Datex2ParkingStatus {
  recordId: string;
  vacantSpaces?: number;
  occupiedSpaces?: number;
  occupancyPercent?: number;
  siteStatus?: string;
  originTime?: string;
}

/** Loosely-typed node from fast-xml-parser output (XML shape is inherently dynamic). */
// biome-ignore lint/suspicious/noExplicitAny: XML parser returns dynamic structure
type XmlNode = Record<string, any>;

const ARRAY_TAGS = new Set([
  "parkingRecord",
  "parkingRecordStatus",
  "parkingTable",
  "groupOfParkingSpaces",
  "parkingEquipmentOrServiceFacility",
  "value",
  "chargeBand",
]);

function createParser(): XMLParser {
  return new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name: string) => ARRAY_TAGS.has(name),
  });
}

function asArray(val: unknown): XmlNode[] {
  if (Array.isArray(val)) return val;
  return val != null ? [val] : [];
}

/**
 * Parse a Datex II v2 ParkingTablePublication XML into parking records.
 *
 * Expected path:
 *   d2LogicalModel > payloadPublication > genericPublicationExtension
 *     > parkingTablePublication > parkingTable[] > parkingRecord[]
 */
export function parseDatex2Table(xml: string): Datex2ParkingRecord[] {
  const parser = createParser();
  const doc: XmlNode = parser.parse(xml);

  const model = doc.d2LogicalModel ?? doc;
  const pub = model.payloadPublication;
  if (!pub) return [];

  const ext = pub.genericPublicationExtension;
  const tablePub = ext?.parkingTablePublication ?? pub;

  const tables = asArray(tablePub?.parkingTable);
  const result: Datex2ParkingRecord[] = [];

  for (const table of tables) {
    for (const rec of asArray(table.parkingRecord)) {
      const id = rec["@_id"];
      if (!id) continue;

      // Name (multilingual values)
      const names = asArray(rec.parkingName?.values?.value);
      const name =
        names.length > 0
          ? typeof names[0] === "object"
            ? (names[0]["#text"] ?? String(names[0]))
            : String(names[0])
          : id;

      // Coordinates
      const coords = rec.parkingLocation?.pointByCoordinates?.pointCoordinates;
      if (!coords) continue;
      const latitude = parseFloat(String(coords.latitude ?? "0"));
      const longitude = parseFloat(String(coords.longitude ?? "0"));
      if (latitude === 0 && longitude === 0) continue;

      // Tariff — fast-xml-parser coerces `<freeOfCharge>true</freeOfCharge>` to a
      // boolean, so handle both boolean and string forms and preserve undefined.
      const feeRaw = rec.tariffsAndPayment?.freeOfCharge;
      const freeOfCharge: boolean | undefined =
        typeof feeRaw === "boolean"
          ? feeRaw
          : feeRaw === "true"
            ? true
            : feeRaw === "false"
              ? false
              : undefined;

      // Total spaces from groupOfParkingSpaces
      let totalSpaces = 0;
      for (const group of asArray(rec.groupOfParkingSpaces)) {
        const spaces = parseInt(String(group?.parkingNumberOfSpaces ?? "0"), 10);
        if (!Number.isNaN(spaces)) totalSpaces += spaces;
      }

      // Equipment / service facility types
      const equipmentTypes = asArray(rec.parkingEquipmentOrServiceFacility)
        .map((e: XmlNode) => e?.equipmentOrServiceFacilityType as string | undefined)
        .filter(Boolean) as string[];

      result.push({
        id,
        name,
        latitude,
        longitude,
        freeOfCharge,
        totalSpaces: totalSpaces > 0 ? totalSpaces : undefined,
        equipmentTypes: equipmentTypes.length > 0 ? equipmentTypes : undefined,
      });
    }
  }

  return result;
}

/**
 * Parse a Datex II v3 ParkingStatusPublication XML into parking statuses.
 *
 * Accepts both bare `<payload>` roots (as NDW serves) and feeds wrapped in
 * `<d2LogicalModel>` or `<messageContainer>`.
 */
export function parseDatex2Status(xml: string): Datex2ParkingStatus[] {
  const parser = createParser();
  const doc: XmlNode = parser.parse(xml);

  const payload = doc.payload ?? doc.d2LogicalModel?.payload ?? doc.messageContainer?.payload;
  if (!payload) return [];

  const result: Datex2ParkingStatus[] = [];

  for (const entry of asArray(payload.parkingRecordStatus)) {
    const recordId = entry.parkingRecordReference?.["@_id"];
    if (!recordId) continue;

    const occ = entry.parkingOccupancy;

    result.push({
      recordId,
      vacantSpaces:
        occ?.parkingNumberOfVacantSpaces != null
          ? parseInt(String(occ.parkingNumberOfVacantSpaces), 10)
          : undefined,
      occupiedSpaces:
        occ?.parkingNumberOfOccupiedSpaces != null
          ? parseInt(String(occ.parkingNumberOfOccupiedSpaces), 10)
          : undefined,
      occupancyPercent:
        occ?.parkingOccupancy != null ? parseFloat(String(occ.parkingOccupancy)) : undefined,
      siteStatus: entry.parkingSiteStatus,
      originTime: entry.parkingStatusOriginTime,
    });
  }

  return result;
}
