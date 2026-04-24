import {
  type DatexInput,
  getDatexElementId,
  listDatexParkingRecordStatuses,
  listDatexParkingRecords,
  resolveDatexMultilingualValue,
} from "./datex.js";
import { getXmlAttribute, getXmlChild, getXmlChildren, xmlText } from "./xml.js";

export interface DatexParkingRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  freeOfCharge?: boolean;
  totalSpaces?: number;
  equipmentTypes?: string[];
}

export interface DatexParkingStatus {
  recordId: string;
  vacantSpaces?: number;
  occupiedSpaces?: number;
  occupancyPercent?: number;
  siteStatus?: string;
  originTime?: string;
}

function parseNumber(value: unknown): number | undefined {
  const text = xmlText(value);
  if (!text) return undefined;

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: unknown): number | undefined {
  const text = xmlText(value);
  if (!text) return undefined;

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  const text = xmlText(value);
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

export function parseDatexParkingTable(input: DatexInput): DatexParkingRecord[] {
  const result: DatexParkingRecord[] = [];

  for (const record of listDatexParkingRecords(input)) {
    const id = getDatexElementId(record);
    if (!id) continue;

    const coords = getXmlChild(
      getXmlChild(getXmlChild(record, "parkingLocation"), "pointByCoordinates"),
      "pointCoordinates",
    );
    const latitude = parseNumber(coords?.latitude);
    const longitude = parseNumber(coords?.longitude);
    if (latitude == null || longitude == null) continue;
    if (latitude === 0 && longitude === 0) continue;

    const equipmentTypes = getXmlChildren(record, "parkingEquipmentOrServiceFacility")
      .map((entry) => xmlText(entry.equipmentOrServiceFacilityType))
      .filter((value): value is string => Boolean(value));

    let totalSpaces = 0;
    for (const group of getXmlChildren(record, "groupOfParkingSpaces")) {
      totalSpaces += parseInteger(group.parkingNumberOfSpaces) ?? 0;
    }

    result.push({
      id,
      name: resolveDatexMultilingualValue(record.parkingName) ?? id,
      latitude,
      longitude,
      freeOfCharge: parseBoolean(getXmlChild(record, "tariffsAndPayment")?.freeOfCharge),
      totalSpaces: totalSpaces > 0 ? totalSpaces : undefined,
      equipmentTypes: equipmentTypes.length > 0 ? equipmentTypes : undefined,
    });
  }

  return result;
}

export function parseDatexParkingStatus(input: DatexInput): DatexParkingStatus[] {
  const result: DatexParkingStatus[] = [];

  for (const entry of listDatexParkingRecordStatuses(input)) {
    const recordId = getXmlAttribute(getXmlChild(entry, "parkingRecordReference"), "id");
    if (!recordId) continue;

    const occupancy = getXmlChild(entry, "parkingOccupancy");
    result.push({
      recordId,
      vacantSpaces: parseInteger(occupancy?.parkingNumberOfVacantSpaces),
      occupiedSpaces: parseInteger(occupancy?.parkingNumberOfOccupiedSpaces),
      occupancyPercent: parseNumber(occupancy?.parkingOccupancy),
      siteStatus: xmlText(entry.parkingSiteStatus),
      originTime: xmlText(entry.parkingStatusOriginTime),
    });
  }

  return result;
}
