import { USER_AGENT } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";

/**
 * Every IWLS station with water-level predictions. IWLS refuses a `max`
 * above 1,000, and it lists more stations than that; without `max` it
 * answers all of them.
 */
const STATION_LIST_URL = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations?time-series-code=wlp";
const TIMEOUT_MS = 20_000;
/** The list of about 1,150 stations is under a megabyte. */
const MAX_BYTES = 8 * 1024 * 1024;

/** An IWLS station with the time series codes it publishes. */
export interface IwlsCatalogStation {
  /** Stable IWLS identifier, accepted by the data endpoint. */
  id: string;
  /** Five-digit station code. */
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Time series codes such as `wlp`, `wlp-hilo`, `wlo` or `wcs1`. */
  timeSeries: string[];
}

interface IwlsStationRaw {
  id?: unknown;
  code?: unknown;
  officialName?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timeSeries?: unknown;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Canada's IWLS tide stations. A failed request rejects. */
export async function loadIwlsStations(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<IwlsCatalogStation[]> {
  const raw = await http.get<unknown>(STATION_LIST_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (!Array.isArray(raw)) throw new Error("IWLS station list is not a list");
  const stations: IwlsCatalogStation[] = [];
  for (const entry of raw as IwlsStationRaw[]) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    if (!finite(entry.latitude) || !finite(entry.longitude)) continue;
    const code = typeof entry.code === "string" ? entry.code : "";
    const name = typeof entry.officialName === "string" ? entry.officialName.trim() : "";
    const timeSeries = Array.isArray(entry.timeSeries)
      ? entry.timeSeries.flatMap((series: { code?: unknown }) =>
          typeof series?.code === "string" ? [series.code] : [],
        )
      : [];
    stations.push({
      id: entry.id,
      code,
      name: name || code || entry.id,
      lat: entry.latitude,
      lng: entry.longitude,
      timeSeries,
    });
  }
  return stations;
}
