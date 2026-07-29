import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { cleanString, connector } from "./utils.js";

export const HK_EPD_URL =
  "https://ev-charger.epd.gov.hk/resource/ev_charger_avail/evca_ver_1_0.json";

/**
 * Hong Kong EPD "Electric Vehicle Chargers for Public Access" feed — a single
 * JSON GET returning `{ data: [...], lastUpdateDate }` with ~973 car-park
 * records, static-only (no pricing, no reliable live availability — the
 * per-combination `availableCharger` fields are frequently null).
 *
 * `chargerTypeID` and `chargingStandardID` are SEPARATE enums that happen to
 * share the value 22 for unrelated things — chargerTypeID 22 means "Fast
 * Charger (>=100kW)" (a power tier), while chargingStandardID 22 means "IEC
 * 62196" / Type 2 (a plug standard). They must not be conflated.
 */

// chargingStandardID -> connector plug type.
const CONNECTOR_TYPE_BY_STANDARD_ID: Record<number, string> = {
  22: "Type 2",
  31: "CCS (Type 2)",
  28: "CHAdeMO",
  16: "Unknown", // GB/T
  19: "Unknown", // BS 1363
};

// chargerTypeID -> approximate rated power tier (kW).
const POWER_KW_BY_CHARGER_TYPE_ID: Record<number, number> = {
  7: 7,
  6: 20,
  5: 100,
  22: 100,
};

interface HkEpdCombination {
  chargerTypeID?: number;
  chargingStandardID?: number;
  sizeOfCharger?: number;
}

interface HkEpdRecord {
  carParkId?: string;
  carParkEName?: string;
  carParkCName?: string;
  carParkEAddress?: string;
  location?: { lat?: number; lng?: number };
  openingHoursEn?: string;
  isEnable?: boolean;
  chargerOperatorAll?: string;
  chargerTotalByCombinations?: HkEpdCombination[];
}

interface HkEpdResponse {
  data?: HkEpdRecord[];
}

function connectorType(standardId: number | undefined): string {
  if (standardId === undefined) return "Unknown";
  return CONNECTOR_TYPE_BY_STANDARD_ID[standardId] ?? "Unknown";
}

// Only CHAdeMO (28) and CCS (31) are DC standards in this feed; everything
// else (Type 2 IEC 62196, GB/T, BS 1363) is treated as AC.
function currentTypeFor(standardId: number | undefined): "AC" | "DC" {
  return standardId === 28 || standardId === 31 ? "DC" : "AC";
}

function operatorName(chargerOperatorAll: string | undefined): string | undefined {
  return cleanString(chargerOperatorAll?.split(";")[0]);
}

function recordToPoi(record: HkEpdRecord): PoiRow | null {
  const poiId = cleanString(record.carParkId);
  const lng = record.location?.lng;
  const lat = record.location?.lat;
  if (!poiId || typeof lng !== "number" || typeof lat !== "number") return null;

  const name =
    cleanString(record.carParkEName) ?? cleanString(record.carParkCName) ?? "EV Charging Station";
  const operator = operatorName(record.chargerOperatorAll);

  const connectors = (record.chargerTotalByCombinations ?? []).map((combo) =>
    connector({
      type: connectorType(combo.chargingStandardID),
      currentType: currentTypeFor(combo.chargingStandardID),
      powerKw:
        combo.chargerTypeID !== undefined
          ? POWER_KW_BY_CHARGER_TYPE_ID[combo.chargerTypeID]
          : undefined,
      quantity: combo.sizeOfCharger,
    }),
  );

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name,
      address: {
        line1: cleanString(record.carParkEAddress),
        country: "Hong Kong",
      },
      operator: operator ? { name: operator } : undefined,
      status: record.isEnable ? "operational" : "unknown",
      openingHours: cleanString(record.openingHoursEn),
      connectors,
      sourceUrl: HK_EPD_URL,
    },
  };
}

export const parseHkEpd: PoiStaticParseFn = (buffer) => {
  let parsed: HkEpdResponse;
  try {
    parsed = JSON.parse(buffer.toString("utf8")) as HkEpdResponse;
  } catch {
    return [];
  }
  const records = parsed?.data;
  if (!Array.isArray(records)) return [];

  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const poi = recordToPoi(record);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
