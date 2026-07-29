import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { parseDelimited, rowsToObjects } from "./csv.js";
import { cleanString, parseLocalizedNumber, stableHashId } from "./utils.js";

export const AU_QLD_CSV_URL =
  "https://www.tmr.qld.gov.au/-/media/aboutus/corpinfo/Open%20data/findachargingev/csl_ev.csv";
const SOURCE_URL = "https://www.tmr.qld.gov.au/";

function rowToPoi(row: Record<string, string>): PoiRow | null {
  const lat = parseLocalizedNumber(row.Latitude);
  const lng = parseLocalizedNumber(row.Longitude);
  if (lat === undefined || lng === undefined) return null;

  const name = cleanString(row["Location Name"]);
  const address = cleanString(row.Address);
  const host = cleanString(row.Host);
  const poiId = stableHashId(name, lat, lng);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: name ?? "EV Charging Station",
      address: {
        line1: address,
        country: "Australia",
      },
      operator: host ? { name: host } : undefined,
      // The feed carries no per-plug status/connector data (the "Charging
      // plugs available" column is always blank) — every listed site is a
      // published, currently-operating QESH charger.
      status: "operational",
      connectors: [],
      sourceUrl: SOURCE_URL,
    },
  };
}

export const parseAuQld: PoiStaticParseFn = (buffer) => {
  // The feed embeds real newlines inside quoted Address / Nearest QESH
  // charging station cells (multi-line directions) — parseDelimited already
  // treats those as part of the quoted cell rather than a row break.
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const rows = rowsToObjects(parseDelimited(text, ","), 0);
  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const poi = rowToPoi(row);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
