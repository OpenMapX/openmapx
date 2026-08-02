import { fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import { hostMatchesAllowlist } from "@openmapx/core/utils/safe-download";
import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { parseDelimited, rowsToObjects } from "./csv.js";
import {
  cleanString,
  connector,
  parseInteger,
  parseLocalizedNumber,
  stableHashId,
} from "./utils.js";

// The NSW register is published as a date-stamped CSV filename
// (its-data-ecars-sites-roi-ni.csv style, but "ev_YYYYMMDD.csv" here), so the
// URL goes stale every time Transport for NSW republishes it. Resolve the
// current resource via the CKAN package_show API at ingest time instead of
// hardcoding a filename that will 404 after the next refresh.
const NSW_PACKAGE_SHOW_URL =
  "https://opendata.transport.nsw.gov.au/data/api/3/action/package_show?id=ev-charging-locations";
const FALLBACK_CSV_URL =
  "https://opendata.transport.nsw.gov.au/data/dataset/be1c4de4-4517-4bd0-8a09-2965ddfc7179/resource/7bbb6461-e52d-4fe7-ace4-a15c30198de0/download/ev_20251216.csv";
const SOURCE_URL = "https://opendata.transport.nsw.gov.au/dataset/ev-charging-locations";

interface CkanPackageShowResponse {
  result?: {
    resources?: Array<{ format?: string; url?: string }>;
  };
}

/**
 * Resolves the current CSV resource URL from the CKAN `package_show` API.
 * The dataset's CSV resource filename is date-stamped
 * (e.g. "ev_20251216.csv") and changes on every republish, so the poi-ingest
 * static fetch can't hardcode it — this runs at ingest time to find whatever
 * CSV resource is current, falling back to a known-good snapshot URL if the
 * API call or resource lookup fails.
 */
export async function resolveNswUrl(log: PoiSourceLogger): Promise<string> {
  try {
    const response = await fetchWithRedirects(NSW_PACKAGE_SHOW_URL, {
      allowedRedirectHosts: ["opendata.transport.nsw.gov.au"],
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeoutMs: 20_000,
    });
    if (!response.ok) throw new Error(`NSW package_show failed: ${response.status}`);
    const data = (await response.json()) as CkanPackageShowResponse;
    const resources = data.result?.resources ?? [];
    const csv = resources.find((resource) => resource.format?.toUpperCase() === "CSV");
    if (csv?.url) {
      try {
        const resolved = new URL(csv.url);
        if (
          (resolved.protocol === "https:" || resolved.protocol === "http:") &&
          hostMatchesAllowlist(resolved.hostname, "opendata.transport.nsw.gov.au")
        ) {
          return resolved.toString();
        }
      } catch {
        // Fall through to the known-good snapshot URL below.
      }
    }
    log.warn("au-nsw-parser: package_show contained no CSV resource — using fallback URL");
  } catch (err) {
    log.warn(`au-nsw-parser: package_show failed (${(err as Error).message}) — using fallback URL`);
  }
  return FALLBACK_CSV_URL;
}

function rowConnector(row: Record<string, string>): EvChargingConnector {
  const chargerType = cleanString(row.Charger_Type);
  const operator = cleanString(row.Operator);
  const isTesla = operator?.toLowerCase() === "tesla";
  const isAc = chargerType?.toUpperCase() === "AC";
  const isDc = chargerType?.toUpperCase() === "DC";

  let type: string | undefined;
  if (isTesla) type = "Tesla";
  else if (isAc) type = "Type 2";
  else if (isDc) type = "CCS (Type 2)";

  return connector({
    type,
    currentType: isAc ? "AC" : isDc ? "DC" : undefined,
    powerKw: parseLocalizedNumber(row.Charger_rating),
    quantity: parseInteger(row.Number_of_plugs),
  });
}

function statusFromRow(row: Record<string, string>): "operational" | "planned" | "unknown" {
  const chargerType = cleanString(row.Charger_Type);
  if (chargerType?.toLowerCase() === "upcoming") return "planned";
  const source = cleanString(row.Source);
  if (source?.toLowerCase().startsWith("existing")) return "operational";
  return "unknown";
}

function rowToPoi(row: Record<string, string>): PoiRow | null {
  const lat = parseLocalizedNumber(row.Latitude);
  const lng = parseLocalizedNumber(row.Longitude);
  if (lat === undefined || lng === undefined) return null;

  const address = cleanString(row.Station_address);
  const operator = cleanString(row.Operator);
  const poiId = stableHashId(address, operator, lat, lng);
  const name = cleanString(row.Station_name) ?? operator ?? "EV Charging Station";

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name,
      address: {
        line1: address,
        town: cleanString(row.LGANAME),
        postcode: cleanString(row.PCODE),
        country: "Australia",
      },
      operator: operator ? { name: operator } : undefined,
      status: statusFromRow(row),
      connectors: [rowConnector(row)],
      sourceUrl: SOURCE_URL,
    },
  };
}

export const parseAuNsw: PoiStaticParseFn = (buffer) => {
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
