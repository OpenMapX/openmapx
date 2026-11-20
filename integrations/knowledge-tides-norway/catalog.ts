import { USER_AGENT } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";

const STATION_LIST_URL =
  "https://vannstand.kartverket.no/tideapi.php?tide_request=stationlist&type=perm&lang=en";
const TIMEOUT_MS = 20_000;
/** The station list is a few KB. */
const MAX_BYTES = 2 * 1024 * 1024;

/** A permanent Kartverket tide station. */
export interface KartverketCatalogStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * The permanent stations of Kartverket's Sehavnivå service. The XML is a flat
 * `<location ... />` list, so a pattern reads it without an XML parser. A
 * failed request rejects.
 */
export async function loadKartverketStations(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<KartverketCatalogStation[]> {
  const response = await http.getText(STATION_LIST_URL, {
    maxBytes: MAX_BYTES,
    contentTypes: ["text/xml", "application/xml"],
    discardErrorBody: true,
    headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,*/*" },
    timeoutMs: TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (response.status !== 200) {
    throw new Error(`Kartverket station list answered HTTP ${response.status}`);
  }
  const stations: KartverketCatalogStation[] = [];
  const pattern =
    /<location\s+name="([^"]+)"\s+code="([^"]+)"\s+latitude="([\d.-]+)"\s+longitude="([\d.-]+)"\s+type="PERM"\s*\/>/g;
  for (const match of response.body.matchAll(pattern)) {
    const lat = Number.parseFloat(match[3] ?? "");
    const lng = Number.parseFloat(match[4] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stations.push({ code: match[2] ?? "", name: match[1] ?? "", lat, lng });
  }
  return stations;
}
