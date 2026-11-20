import { USER_AGENT } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";

/** The `waters` filter leaves the North Sea and Baltic gauges, not the inland rivers. */
const STATION_LIST_URL =
  "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=NORDSEE,OSTSEE";
const TIMEOUT_MS = 20_000;
/** The coastal list is about 20 KB. */
const MAX_BYTES = 4 * 1024 * 1024;

/** A coastal WSV Pegelonline gauge. */
export interface PegelonlineCatalogStation {
  uuid: string;
  name: string;
  lat: number;
  lng: number;
}

interface PegelStationRaw {
  uuid?: unknown;
  shortname?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Germany's coastal Pegelonline gauges. A failed request rejects. */
export async function loadPegelonlineStations(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<PegelonlineCatalogStation[]> {
  const raw = await http.get<unknown>(STATION_LIST_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (!Array.isArray(raw)) throw new Error("Pegelonline station list is not a list");
  const stations: PegelonlineCatalogStation[] = [];
  for (const entry of raw as PegelStationRaw[]) {
    if (typeof entry?.uuid !== "string" || !entry.uuid) continue;
    if (!finite(entry.latitude) || !finite(entry.longitude)) continue;
    const name =
      typeof entry.shortname === "string" ? entry.shortname.replace(/\s+/g, " ").trim() : "";
    stations.push({
      uuid: entry.uuid,
      name: name || entry.uuid,
      lat: entry.latitude,
      lng: entry.longitude,
    });
  }
  return stations;
}
