import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { unzipSync } from "fflate";
import proj4 from "proj4";
import { parseDelimited, rowsToObjects } from "./csv.js";
import { cleanString, connector, newestIsoString, parseLocalizedNumber } from "./utils.js";

export const BE_WALLONIA_URL =
  "https://geoservices.wallonie.be/geotraitement/spwdatadownload/results/c731a282-e378-49f3-8ab6-f9a90e7a5683/BORNES_RECHARGE_CSV.zip";
const SOURCE_URL =
  "https://geoportail.wallonie.be/catalogue/c731a282-e378-49f3-8ab6-f9a90e7a5683.html";

// The bulk download is a ZIP whose CSV carries geometry as WKT in EPSG:31370
// (Belgian Lambert 72) — the ArcGIS query endpoint serves no geometry, so the
// zip is the only usable source. Reproject each point to WGS84. Verified
// against the SPW control point 184781.2, 128873.1 → 4.858691, 50.469649.
const LAMBERT72 =
  "+proj=lcc +lat_1=51.16666723333333 +lat_2=49.8333339 +lat_0=90 +lon_0=4.367486666666666 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs";
const lambert72ToWgs84 = proj4(LAMBERT72, "WGS84");

function reprojectWkt(wkt: string | undefined): [number, number] | null {
  const match = wkt?.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return null;
  const x = Number.parseFloat(match[1]);
  const y = Number.parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const [lng, lat] = lambert72ToWgs84.forward([x, y]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

// TYPE_RECHARGE is a power TIER (Normal/Rapide/Ultra-rapide), not a plug type,
// and the feed carries no connector-standard field — so infer from power:
// ≤22 kW is AC (Type 2), above is DC (CCS). Low-confidence but the only signal.
function rowConnector(power: number | undefined): EvChargingConnector {
  const isDc = power !== undefined && power > 22;
  return connector({
    type: isDc ? "CCS (Type 2)" : "Type 2",
    powerKw: power,
    currentType: isDc ? "DC" : "AC",
    quantity: 1,
  });
}

interface WalloniaGroup {
  coordinates: [number, number];
  operator?: string;
  address?: string;
  postcode?: string;
  town?: string;
  state?: string;
  connectors: EvChargingConnector[];
  updates: (string | undefined)[];
}

/** Parses the decompressed `;`-delimited CSV text into grouped station rows. */
export function parseWalloniaRows(text: string): PoiRow[] {
  const rows = rowsToObjects(parseDelimited(text.replace(/^﻿/, ""), ";"), 0);
  const groups = new Map<string, WalloniaGroup>();

  for (const row of rows) {
    const emplacementId = cleanString(row.EMPLACEMENT_ID);
    const coordinates = reprojectWkt(row.WKT_GEOM);
    if (!emplacementId || !coordinates) continue;

    const existing = groups.get(emplacementId);
    const power = parseLocalizedNumber(row.PUISSANCE_KW);
    if (existing) {
      existing.connectors.push(rowConnector(power));
      existing.updates.push(cleanString(row.DATETRANS));
      continue;
    }
    groups.set(emplacementId, {
      coordinates,
      operator: cleanString(row.OPERATEUR),
      address: cleanString(row.ADRESSE),
      postcode: cleanString(row.CODE_POSTAL),
      town: cleanString(row.VILLE),
      state: cleanString(row.PROVINCE),
      connectors: [rowConnector(power)],
      updates: [cleanString(row.DATETRANS)],
    });
  }

  const out: PoiRow[] = [];
  for (const [poiId, group] of groups) {
    const name = [group.operator, group.address].filter(Boolean).join(" – ");
    out.push({
      poiId,
      lng: group.coordinates[0],
      lat: group.coordinates[1],
      payload: {
        coordinates: group.coordinates,
        name: name || "EV Charging Station",
        address: {
          line1: group.address,
          town: group.town,
          state: group.state,
          postcode: group.postcode,
          country: "Belgium",
        },
        operator: group.operator ? { name: group.operator } : undefined,
        status: "unknown",
        connectors: group.connectors,
        updatedAt: newestIsoString(group.updates),
        sourceUrl: SOURCE_URL,
      },
    });
  }
  return out;
}

export const parseBeWallonia: PoiStaticParseFn = (buffer) => {
  const files = unzipSync(new Uint8Array(buffer));
  const csvName = Object.keys(files).find((name) => name.toLowerCase().endsWith(".csv"));
  if (!csvName) return [];
  return parseWalloniaRows(Buffer.from(files[csvName]).toString("utf8"));
};
