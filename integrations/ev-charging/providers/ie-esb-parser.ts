import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { parseDelimited, rowsToObjects } from "./csv.js";
import {
  cleanString,
  connector,
  parseInteger,
  parseLocalizedNumber,
  stableHashId,
} from "./utils.js";

export const IE_ESB_CSV_URL =
  "https://cdn.esb.ie/media-staging/docs/default-source/ecars/its-data-ecars-sites/its-data-ecars-sites-roi-ni.csv";
const SOURCE_URL = "https://data.gov.ie/dataset/esb-ev-public-charging-network";

// The ESB register has no station name or id column, and the header carries
// stray/inconsistent whitespace ("VAT Rate " trailing space, a double space in
// the high-power price header). Normalise header keys to lowercase single-space
// so lookups don't depend on the exact upstream spacing.
function normaliseKeys(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.trim().replace(/\s+/g, " ").toLowerCase()] = value;
  }
  return out;
}

function firstSegment(address: string | undefined): string | undefined {
  return cleanString(address?.split(",")[0]);
}

function openingHours(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  return /^24\s*x\s*7$/i.test(cleaned) ? "24/7" : cleaned;
}

function usageCost(row: Record<string, string>): string | undefined {
  const parts: string[] = [];
  const fast = cleanString(row["price - fast charger ( 43 - 100kw)"]);
  const high = cleanString(row["price - high power charger (150 - 360 kw)"]);
  const ac = cleanString(row["price ac charger (22kw)"]);
  if (fast) parts.push(`Fast: ${fast}`);
  if (high) parts.push(`High power: ${high}`);
  if (ac) parts.push(`AC: ${ac}`);
  if (parts.length === 0) return undefined;
  const vat = cleanString(row["vat rate"]);
  return vat ? `${parts.join("; ")} (VAT ${vat})` : parts.join("; ");
}

function rowConnectors(row: Record<string, string>): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];
  const add = (qtyKey: string, powerKey: string, type: string, currentType: "AC" | "DC") => {
    const quantity = parseInteger(row[qtyKey]) ?? 0;
    if (quantity <= 0) return;
    connectors.push(
      connector({ type, powerKw: parseLocalizedNumber(row[powerKey]), currentType, quantity }),
    );
  };
  // "Max. Sim." columns are the count of simultaneous connectors of each type;
  // the "kWs" columns give the rated power (either bare "50" or "22(2)" where
  // the parenthesised value repeats the count — the leading number is the kW).
  add("max. sim. ccs", "ccs kws", "CCS (Type 2)", "DC");
  add("max. sim. chademo", "chademo kws", "CHAdeMO", "DC");
  add("max. sim. fast ac", "ac fast kws", "Type 2", "AC");
  add("max. sim. ac socket", "ac socket kws", "Type 2", "AC");
  return connectors;
}

function rowToPoi(raw: Record<string, string>): PoiRow | null {
  const row = normaliseKeys(raw);
  const lat = parseLocalizedNumber(row.latitude);
  const lng = parseLocalizedNumber(row.longitude);
  if (lat === undefined || lng === undefined) return null;

  const territory = cleanString(row.territory);
  const address = cleanString(row.address);
  const poiId = stableHashId(territory, address, lat, lng);
  const country = territory?.toUpperCase() === "NI" ? "United Kingdom" : "Ireland";
  const overstay = cleanString(row["overstay fees"]);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: firstSegment(address) ?? "EV Charging Station",
      address: {
        line1: address,
        state: cleanString(row.county),
        country,
      },
      operator: { name: "ESB ecars" },
      status: "unknown",
      connectors: rowConnectors(row),
      usageCost: usageCost(row),
      openingHours: openingHours(row["open hours"]),
      sourceUrl: SOURCE_URL,
      notes: overstay ? [overstay] : undefined,
    },
  };
}

export const parseIeEsb: PoiStaticParseFn = (buffer) => {
  // File is UTF-8 with a BOM; strip it so the first header cell isn't "﻿Territory".
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const rows = rowsToObjects(parseDelimited(text, ","), 0);
  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const poi = rowToPoi(raw);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
