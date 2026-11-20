import { USER_AGENT } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";

const STATION_LIST_URL =
  "https://www.ioc-sealevelmonitoring.org/service.php?query=stationlist&format=json";
const TIMEOUT_MS = 20_000;
/** The list of about 1,700 gauges is half a megabyte. */
const MAX_BYTES = 8 * 1024 * 1024;

/** An active IOC sea-level gauge. */
export interface IocCatalogStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-3 country code, when IOC names one. */
  country?: string;
}

interface IocStationRaw {
  Code?: unknown;
  Location?: unknown;
  country?: unknown;
  Lat?: unknown;
  Lon?: unknown;
  status?: unknown;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The active gauges of the IOC Sea Level Station Monitoring Facility. The
 * catalog includes historic gauges and repeats some codes; both are dropped.
 * A failed request rejects.
 */
export async function loadIocStations(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<IocCatalogStation[]> {
  const raw = await http.get<unknown>(STATION_LIST_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (!Array.isArray(raw)) throw new Error("IOC station list is not a list");
  const byCode = new Map<string, IocCatalogStation>();
  for (const entry of raw as IocStationRaw[]) {
    if (entry?.status !== 1 || typeof entry.Code !== "string" || !entry.Code) continue;
    if (!finite(entry.Lat) || !finite(entry.Lon) || byCode.has(entry.Code)) continue;
    const name = typeof entry.Location === "string" ? entry.Location.trim() : "";
    byCode.set(entry.Code, {
      code: entry.Code,
      name: name || entry.Code,
      lat: entry.Lat,
      lng: entry.Lon,
      ...(typeof entry.country === "string" && entry.country ? { country: entry.country } : {}),
    });
  }
  return [...byCode.values()];
}
