import type {
  AirportFrequencyInfo,
  AirportNavaidInfo,
  AirportRunwayInfo,
  AirportType,
} from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import { type CsvRecord, parseCsv, parseOptionalFloat, parseOptionalInt } from "./csv.js";
import { buildSearchIndex, type SearchIndex } from "./search.js";
import type { AirportRecord } from "./types.js";

const BASE_URL = "https://davidmegginson.github.io/ourairports-data";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

const AIRPORT_TYPES = new Set<AirportType>([
  "balloonport",
  "closed_airport",
  "heliport",
  "large_airport",
  "medium_airport",
  "seaplane_base",
  "small_airport",
]);

/** Airport types eligible for the spatial fallback used by infra features. */
const SPATIAL_FALLBACK_TYPES = new Set<AirportType>([
  "large_airport",
  "medium_airport",
  "small_airport",
  "heliport",
  "seaplane_base",
]);

/**
 * Per-file conditional-GET state. Keyed by file name. When an upstream
 * response carries an `ETag` or `Last-Modified` header, we send the value
 * back on the next refresh and treat a 304 as "no change — reuse the
 * previous parsed body".
 */
interface ConditionalGet {
  etag?: string;
  lastModified?: string;
  body?: string;
}

export interface DataStore {
  byIata: Map<string, AirportRecord>;
  byIcao: Map<string, AirportRecord>;
  byIdent: Map<string, AirportRecord>;
  byGpsCode: Map<string, AirportRecord>;
  byLocalCode: Map<string, AirportRecord>;
  /**
   * Spatial index over real airport entities (aerodromes + heliports).
   * Bucketed by `${floor(lat)},${floor(lng)}` 1-degree cells. Lookup probes
   * the cell plus its 8 neighbours so airports near a bucket boundary are
   * found.
   */
  spatialBuckets: Map<string, AirportRecord[]>;
  /** All airport records — used by overlay bbox queries and search. */
  all: AirportRecord[];
  /** IATA / ICAO / name / keyword search index. */
  search: SearchIndex;
  loadedAt: number;
}

let store: DataStore | null = null;
let loadPromise: Promise<DataStore | null> | null = null;
let lastFailureAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const refreshOwners = new Set<symbol>();
const conditionalState = new Map<string, ConditionalGet>();

export function startBackgroundLoad(log: Logger): () => void {
  const owner = Symbol("ourairports-background-load-owner");
  refreshOwners.add(owner);
  void ensureLoaded(log);
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void ensureLoaded(log, /* force */ true);
    }, REFRESH_INTERVAL_MS);
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refreshOwners.delete(owner);
    if (refreshOwners.size === 0) stopRefreshTimer();
  };
}

export function stopBackgroundLoad(): void {
  refreshOwners.clear();
  stopRefreshTimer();
}

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Return the currently-loaded store, awaiting a load if one isn't ready yet.
 * Idempotent — multiple callers can race and all get the same Promise.
 */
export async function getStore(log: Logger): Promise<DataStore | null> {
  return store ?? (await ensureLoaded(log));
}

async function ensureLoaded(log: Logger, force = false): Promise<DataStore | null> {
  if (store && !force && Date.now() - store.loadedAt < REFRESH_INTERVAL_MS) return store;
  if (loadPromise) return loadPromise;
  if (!force && lastFailureAt && Date.now() - lastFailureAt < RETRY_BACKOFF_MS) return store;

  loadPromise = doLoad(log)
    .then((next) => {
      store = next;
      lastFailureAt = 0;
      return next;
    })
    .catch((err) => {
      lastFailureAt = Date.now();
      log.warn(
        `ourairports-data: failed to load CSV data: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return store;
    })
    .finally(() => {
      loadPromise = null;
    });

  return loadPromise;
}

async function doLoad(log: Logger): Promise<DataStore> {
  log.info("ourairports-data: fetching CSV dumps");
  const start = Date.now();

  const [airportsCsv, runwaysCsv, frequenciesCsv, navaidsCsv] = await Promise.all([
    fetchText(`${BASE_URL}/airports.csv`),
    fetchText(`${BASE_URL}/runways.csv`),
    fetchText(`${BASE_URL}/airport-frequencies.csv`),
    fetchText(`${BASE_URL}/navaids.csv`),
  ]);

  const airportRows = parseCsv(airportsCsv);
  const runwayRows = parseCsv(runwaysCsv);
  const frequencyRows = parseCsv(frequenciesCsv);
  const navaidRows = parseCsv(navaidsCsv);

  const runwaysByAirportId = new Map<number, AirportRunwayInfo[]>();
  for (const row of runwayRows) {
    const airportId = parseOptionalInt(row.airport_ref);
    if (airportId === undefined) continue;
    if (!runwaysByAirportId.has(airportId)) runwaysByAirportId.set(airportId, []);
    runwaysByAirportId.get(airportId)?.push(toRunway(row));
  }

  const frequenciesByAirportId = new Map<number, AirportFrequencyInfo[]>();
  for (const row of frequencyRows) {
    const airportId = parseOptionalInt(row.airport_ref);
    const freq = parseOptionalFloat(row.frequency_mhz);
    if (airportId === undefined || freq === undefined) continue;
    if (!frequenciesByAirportId.has(airportId)) frequenciesByAirportId.set(airportId, []);
    frequenciesByAirportId.get(airportId)?.push({
      type: row.type || "UNKNOWN",
      description: row.description || undefined,
      frequencyMhz: freq,
    });
  }

  // Navaids are keyed by associated_airport (ident), not airport_ref.
  const navaidsByIdent = new Map<string, AirportNavaidInfo[]>();
  for (const row of navaidRows) {
    const ident = row.associated_airport?.trim().toUpperCase();
    if (!ident) continue;
    if (!navaidsByIdent.has(ident)) navaidsByIdent.set(ident, []);
    navaidsByIdent.get(ident)?.push({
      ident: row.ident || "?",
      name: row.name || undefined,
      type: row.type || "UNKNOWN",
      frequencyKhz: parseOptionalInt(row.frequency_khz),
    });
  }

  const byIata = new Map<string, AirportRecord>();
  const byIcao = new Map<string, AirportRecord>();
  const byIdent = new Map<string, AirportRecord>();
  const byGpsCode = new Map<string, AirportRecord>();
  const byLocalCode = new Map<string, AirportRecord>();
  const spatialBuckets = new Map<string, AirportRecord[]>();
  const all: AirportRecord[] = [];

  for (const row of airportRows) {
    const id = parseOptionalInt(row.id);
    if (id === undefined) continue;
    const type = AIRPORT_TYPES.has(row.type as AirportType)
      ? (row.type as AirportType)
      : "small_airport";
    const ident = row.ident?.trim().toUpperCase();
    if (!ident) continue;
    const lat = parseOptionalFloat(row.latitude_deg);
    const lng = parseOptionalFloat(row.longitude_deg);
    if (lat === undefined || lng === undefined) continue;
    const name = row.name?.trim();
    if (!name) continue;

    const record: AirportRecord = {
      id,
      ident,
      type,
      iata: row.iata_code ? row.iata_code.trim().toUpperCase() : undefined,
      icao: row.icao_code ? row.icao_code.trim().toUpperCase() : undefined,
      gpsCode: row.gps_code ? row.gps_code.trim().toUpperCase() : undefined,
      localCode: row.local_code ? row.local_code.trim().toUpperCase() : undefined,
      elevationFt: parseOptionalInt(row.elevation_ft),
      scheduledService: row.scheduled_service?.toLowerCase() === "yes",
      municipality: row.municipality || undefined,
      isoCountry: row.iso_country || undefined,
      isoRegion: row.iso_region || undefined,
      homeLink: row.home_link || undefined,
      wikipediaLink: row.wikipedia_link || undefined,
      runways: dedupeRunways(runwaysByAirportId.get(id)),
      frequencies: sortFrequencies(frequenciesByAirportId.get(id)),
      navaids: sortNavaids(navaidsByIdent.get(ident)),
      lat,
      lng,
      name,
      continent: row.continent || undefined,
      keywords: row.keywords || undefined,
    };

    byIdent.set(ident, record);
    if (record.iata) byIata.set(record.iata, record);
    if (record.icao) byIcao.set(record.icao, record);
    if (record.gpsCode) byGpsCode.set(record.gpsCode, record);
    if (record.localCode) byLocalCode.set(record.localCode, record);
    all.push(record);

    if (SPATIAL_FALLBACK_TYPES.has(type)) {
      const key = `${Math.floor(lat)},${Math.floor(lng)}`;
      const bucket = spatialBuckets.get(key);
      if (bucket) bucket.push(record);
      else spatialBuckets.set(key, [record]);
    }
  }

  const search = buildSearchIndex(all);

  log.info(
    `ourairports-data: loaded ${byIdent.size} airports ` +
      `(${byIata.size} with IATA, ${byIcao.size} with ICAO) in ${Date.now() - start}ms`,
  );

  return {
    byIata,
    byIcao,
    byIdent,
    byGpsCode,
    byLocalCode,
    spatialBuckets,
    all,
    search,
    loadedAt: Date.now(),
  };
}

function toRunway(row: CsvRecord): AirportRunwayInfo {
  const le = row.le_ident?.trim() ?? "";
  const he = row.he_ident?.trim() ?? "";
  const ident = le && he ? `${le}/${he}` : le || he || "?";
  return {
    ident,
    lengthFt: parseOptionalInt(row.length_ft),
    widthFt: parseOptionalInt(row.width_ft),
    surface: row.surface?.trim() || undefined,
    closed: row.closed === "1",
    lighted: row.lighted === "1",
    headingDegT: parseOptionalInt(row.le_heading_degT),
  };
}

function dedupeRunways(runways: AirportRunwayInfo[] | undefined): AirportRunwayInfo[] | undefined {
  if (!runways?.length) return undefined;
  // Show open runways first, then closed; preserve length-desc ordering within each.
  return [...runways].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return (b.lengthFt ?? 0) - (a.lengthFt ?? 0);
  });
}

function sortFrequencies(
  freqs: AirportFrequencyInfo[] | undefined,
): AirportFrequencyInfo[] | undefined {
  if (!freqs?.length) return undefined;
  // Stable type order — tower/ground/clearance/atis on top, info channels later.
  const priority: Record<string, number> = {
    TWR: 1,
    GND: 2,
    CLD: 3,
    DEL: 3,
    APP: 4,
    ARR: 5,
    DEP: 6,
    CTAF: 7,
    UNICOM: 8,
    ATIS: 9,
    AWOS: 10,
    ASOS: 11,
    RMP: 12,
    RCO: 13,
    RDO: 14,
    ATF: 15,
  };
  return [...freqs].sort((a, b) => {
    const pa = priority[a.type] ?? 99;
    const pb = priority[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.frequencyMhz - b.frequencyMhz;
  });
}

function sortNavaids(navaids: AirportNavaidInfo[] | undefined): AirportNavaidInfo[] | undefined {
  if (!navaids?.length) return undefined;
  return [...navaids].sort((a, b) => a.ident.localeCompare(b.ident));
}

/**
 * Fetch one CSV file with conditional-GET support. Sends `If-None-Match` and
 * `If-Modified-Since` from the previous response; if the server returns 304
 * (Not Modified) we reuse the previously-parsed body — saves ~19 MB of
 * download per refresh when upstream is unchanged (which is most days for
 * stable feeds like `countries.csv`).
 */
async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const prior = conditionalState.get(url);
  if (prior?.etag) headers["If-None-Match"] = prior.etag;
  if (prior?.lastModified) headers["If-Modified-Since"] = prior.lastModified;

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 304 && prior?.body) {
      return prior.body;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const body = await res.text();
    conditionalState.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      body,
    });
    return body;
  } finally {
    clearTimeout(timer);
  }
}
