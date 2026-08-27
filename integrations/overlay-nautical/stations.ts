/**
 * Multi-network tide-gauge / water-level catalog loaders + dedup, shared by
 * the `/stations` route in `index.ts`.
 *
 * Adds five non-US networks alongside the existing NOAA catalog:
 *
 *  - **IOC** Sea Level Station Monitoring Facility (UNESCO) — global observations
 *  - **EMODnet Physics** near-real-time sea level (`ERD_EP_SLEV_NRT_60m`) — pan-Europe
 *  - **DFO IWLS** (Canada) — predictions + observations
 *  - **Kartverket** Sehavnivå (Norway) — predictions + observations
 *  - **WSV Pegelonline** (Germany) — coastal/estuarine observations
 *
 * All networks: free, no API key, commercial use permitted (verified 2026-05-18).
 *
 * Dedup priority when stations overlap within ~500m, highest first:
 *   NOAA > Canada (IWLS) > Norway (Kartverket) > Pegelonline > EMODnet > IOC
 *
 * National hydrographic offices outrank EMODnet/IOC because they hold the
 * authoritative tide-prediction harmonics; EMODnet outranks IOC because it
 * normalises its data through national QC pipelines.
 */
import { fetchJson, haversineKm } from "@openmapx/core";
import type { CacheClient, Logger } from "@openmapx/integration-framework";

export type TideNetwork = "noaa" | "ca-iwls" | "kartverket" | "pegel" | "emodnet" | "ioc";

export type TideStationCapability = "tide-predictions" | "water-level" | "currents";

export interface MergedTideStation {
  /** Network this station belongs to. Drives the place-panel scheme. */
  network: TideNetwork;
  /** Network-local station identifier (NOT URL-encoded). */
  id: string;
  /** Human-readable name. */
  name: string;
  lat: number;
  lng: number;
  /** Capabilities at this station — predictions / observations / currents. */
  types: TideStationCapability[];
  /** ISO 3166-1 alpha-2 country code, when known. */
  country?: string;
}

/** Network → dedup rank. Lower wins. */
const NETWORK_RANK: Record<TideNetwork, number> = {
  noaa: 0,
  "ca-iwls": 1,
  kartverket: 2,
  pegel: 3,
  emodnet: 4,
  ioc: 5,
};

const CATALOG_TTL = 7 * 24 * 60 * 60; // 7d
const FETCH_TIMEOUT_MS = 20_000;

async function fetchJsonWithTimeout<T>(url: string, ua: string): Promise<T | null> {
  return fetchJson<T>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    nullOnError: true,
    userAgent: ua,
    headers: { Accept: "application/json" },
  });
}

// -------- IOC Sea Level Station Monitoring (UNESCO) ----------------------
interface IocStationRaw {
  Code: string;
  Location: string;
  country?: string; // 3-letter (DMK, GBR, …)
  countryname?: string;
  Lat: number;
  Lon: number;
  sensor?: string; // "rad", "bub", "prs", …
  status?: number; // 1 = active
}

const IOC_URL = "https://www.ioc-sealevelmonitoring.org/service.php?query=stationlist&format=json";

async function loadIocStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const cacheKey = "catalog:ioc";
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;

  const raw = await fetchJsonWithTimeout<IocStationRaw[]>(IOC_URL, ua);
  if (!raw) {
    log.warn("IOC station list unavailable");
    return [];
  }
  // Active stations only; the catalog includes historic gauges.
  const seenByCode = new Map<string, MergedTideStation>();
  for (const s of raw) {
    if (s.status !== 1) continue;
    if (!Number.isFinite(s.Lat) || !Number.isFinite(s.Lon)) continue;
    const existing = seenByCode.get(s.Code);
    if (existing) continue;
    seenByCode.set(s.Code, {
      network: "ioc",
      id: s.Code,
      name: s.Location?.trim() || s.Code,
      lat: s.Lat,
      lng: s.Lon,
      // IOC publishes observations only (no harmonic predictions in the API).
      types: ["water-level"],
      country: iso3to2(s.country),
    });
  }
  const stations = Array.from(seenByCode.values());
  await cache.set(cacheKey, stations, CATALOG_TTL);
  return stations;
}

// ISO-3166 alpha-3 → alpha-2 for the ~30 codes IOC uses heavily. Falls back to
// undefined (rather than a wrong guess) for unknown codes.
export function iso3to2(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    AUS: "AU",
    BEL: "BE",
    BGD: "BD",
    BRA: "BR",
    CAN: "CA",
    CHL: "CL",
    CHN: "CN",
    DEU: "DE",
    DMK: "DK",
    DNK: "DK",
    ESP: "ES",
    FIN: "FI",
    FRA: "FR",
    GBR: "GB",
    GRB: "GB",
    GRC: "GR",
    HRV: "HR",
    IDN: "ID",
    IND: "IN",
    IRL: "IE",
    ISL: "IS",
    ITA: "IT",
    JAP: "JP",
    JPN: "JP",
    KOR: "KR",
    LVA: "LV",
    MEX: "MX",
    NLD: "NL",
    NOR: "NO",
    NZL: "NZ",
    PHL: "PH",
    POL: "PL",
    PRT: "PT",
    RUS: "RU",
    SWE: "SE",
    THA: "TH",
    TUR: "TR",
    TWN: "TW",
    USA: "US",
    VEN: "VE",
    ZAF: "ZA",
  };
  return map[code.toUpperCase()];
}

// -------- EMODnet Physics — ERD_EP_SLEV_NRT_60m --------------------------
interface EmodnetFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    platformcode: string;
    platformTypeDescription?: string;
    parametersgroupdescr?: string;
    last_date_observation?: string;
  };
}

const EMODNET_WFS_URL =
  "https://prod-geoserver.emodnet-physics.eu/geoserver/EMODnet/ows" +
  "?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=EMODnet:ERD_EP_SLEV_NRT_60m" +
  "&outputFormat=application/json&count=5000";

async function loadEmodnetStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const cacheKey = "catalog:emodnet";
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;

  const raw = await fetchJsonWithTimeout<{ features: EmodnetFeature[] }>(EMODNET_WFS_URL, ua);
  if (!raw?.features) {
    log.warn("EMODnet station list unavailable");
    return [];
  }
  const stations: MergedTideStation[] = [];
  const now = Date.now();
  const HORIZON_DAYS = 365;
  for (const f of raw.features) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const code = f.properties.platformcode;
    if (!code) continue;
    // Filter to gauges with observations in the last year — the layer contains
    // some legacy entries with `last_date_observation` decades in the past.
    const lastObs = f.properties.last_date_observation
      ? Date.parse(f.properties.last_date_observation)
      : 0;
    if (!Number.isFinite(lastObs)) continue;
    const ageDays = (now - lastObs) / (1000 * 60 * 60 * 24);
    if (ageDays < 0 || ageDays > HORIZON_DAYS) continue;
    stations.push({
      network: "emodnet",
      id: code,
      name: code, // EMODnet doesn't ship a friendly name on this layer
      lat,
      lng,
      types: ["water-level"],
    });
  }
  await cache.set(cacheKey, stations, CATALOG_TTL);
  return stations;
}

// -------- DFO IWLS (Canada) ---------------------------------------------
interface IwlsTimeSeries {
  code: string; // "wlo" | "wlp" | "wlp-hilo" | "wcs1" | …
}
interface IwlsStationRaw {
  id: string;
  code: string;
  officialName: string;
  alternativeName?: string;
  latitude: number;
  longitude: number;
  operating: boolean;
  timeSeries: IwlsTimeSeries[];
}

const IWLS_URL = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations?time-series-code=wlp&max=2000";

async function loadCanadaStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const cacheKey = "catalog:ca-iwls";
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;

  const raw = await fetchJsonWithTimeout<IwlsStationRaw[]>(IWLS_URL, ua);
  if (!raw) {
    log.warn("IWLS station list unavailable");
    return [];
  }
  const stations: MergedTideStation[] = raw
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => {
      const tsCodes = new Set(s.timeSeries.map((t) => t.code));
      const types: TideStationCapability[] = [];
      if (tsCodes.has("wlp") || tsCodes.has("wlp-hilo")) types.push("tide-predictions");
      if (tsCodes.has("wlo")) types.push("water-level");
      if (tsCodes.has("wcs1") || tsCodes.has("wcd1")) types.push("currents");
      return {
        network: "ca-iwls" as const,
        // Mongo ObjectId is the stable handle; the 5-digit `code` is also valid
        // but `id` round-trips through the data endpoint without translation.
        id: s.id,
        name: s.officialName.trim() || s.code,
        lat: s.latitude,
        lng: s.longitude,
        types: types.length ? types : ["water-level"],
        country: "CA",
      };
    });
  await cache.set(cacheKey, stations, CATALOG_TTL);
  return stations;
}

// -------- Kartverket Sehavnivå (Norway) ---------------------------------
const KARTVERKET_STATIONLIST_URL =
  "https://vannstand.kartverket.no/tideapi.php?tide_request=stationlist&type=perm&lang=en";

async function loadNorwayStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const cacheKey = "catalog:kartverket";
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(KARTVERKET_STATIONLIST_URL, {
      headers: { "User-Agent": ua, Accept: "application/xml" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn("Kartverket station list unavailable");
      return [];
    }
    const xml = await res.text();
    // The XML is small + well-formed; a regex parse keeps us off an XML
    // dependency tree (the document is a flat `<location ... />` list).
    const stations: MergedTideStation[] = [];
    const re =
      /<location\s+name="([^"]+)"\s+code="([^"]+)"\s+latitude="([\d.-]+)"\s+longitude="([\d.-]+)"\s+type="PERM"\s*\/>/g;
    for (const m of xml.matchAll(re)) {
      const lat = Number.parseFloat(m[3]);
      const lng = Number.parseFloat(m[4]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      stations.push({
        network: "kartverket",
        id: m[2],
        name: m[1],
        lat,
        lng,
        // Kartverket publishes predictions (PRE) + observations (OBS) for every PERM station.
        types: ["tide-predictions", "water-level"],
        country: "NO",
      });
    }
    await cache.set(cacheKey, stations, CATALOG_TTL);
    return stations;
  } catch {
    return [];
  }
}

// -------- WSV Pegelonline (Germany — coastal gauges only) ---------------
interface PegelStationRaw {
  uuid: string;
  shortname: string;
  longname: string;
  longitude: number;
  latitude: number;
  water?: { shortname: string };
}

const PEGELONLINE_URL =
  "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=NORDSEE,OSTSEE";

async function loadPegelonlineStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const cacheKey = "catalog:pegel";
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;

  const raw = await fetchJsonWithTimeout<PegelStationRaw[]>(PEGELONLINE_URL, ua);
  if (!raw) {
    log.warn("Pegelonline station list unavailable");
    return [];
  }
  // Pre-filter to coastal/estuarine sea-level gauges. The `waters=NORDSEE,OSTSEE`
  // filter on the API already excludes the ~1000 inland river gauges.
  const stations: MergedTideStation[] = raw
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => ({
      network: "pegel" as const,
      id: s.uuid,
      name: s.shortname.replace(/\s+/g, " ").trim(),
      lat: s.latitude,
      lng: s.longitude,
      types: ["water-level"] as TideStationCapability[],
      country: "DE",
    }));
  await cache.set(cacheKey, stations, CATALOG_TTL);
  return stations;
}

// -------- Top-level: load everything in parallel + dedup -----------------
export async function loadAllTideStations(
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<MergedTideStation[]> {
  const [ioc, emodnet, canada, norway, pegel] = await Promise.all([
    loadIocStations(cache, log, ua).catch(() => []),
    loadEmodnetStations(cache, log, ua).catch(() => []),
    loadCanadaStations(cache, log, ua).catch(() => []),
    loadNorwayStations(cache, log, ua).catch(() => []),
    loadPegelonlineStations(cache, log, ua).catch(() => []),
  ]);
  return [...ioc, ...emodnet, ...canada, ...norway, ...pegel];
}

/**
 * Merge a list of stations with proximity-based dedup. When two stations from
 * different networks fall within `maxKm`, the lower-ranked one (per
 * `NETWORK_RANK`) is dropped. Same-network duplicates (rare) are also dropped
 * by ID.
 */
export function dedupTideStations(stations: MergedTideStation[], maxKm = 0.5): MergedTideStation[] {
  // Sort by ascending rank so higher-priority stations are inserted first;
  // subsequent stations within `maxKm` get dropped.
  const sorted = [...stations].sort((a, b) => NETWORK_RANK[a.network] - NETWORK_RANK[b.network]);
  const seenIds = new Set<string>();
  const kept: MergedTideStation[] = [];
  for (const s of sorted) {
    const key = `${s.network}:${s.id}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    let dropped = false;
    for (const k of kept) {
      if (haversineKm(s.lat, s.lng, k.lat, k.lng) <= maxKm) {
        dropped = true;
        break;
      }
    }
    if (!dropped) kept.push(s);
  }
  return kept;
}

/** Bbox query over the already-deduped list. */
export function stationsInBbox(
  stations: MergedTideStation[],
  bbox: { west: number; south: number; east: number; north: number },
  filter?: { network?: TideNetwork; type?: TideStationCapability },
): MergedTideStation[] {
  return stations.filter((s) => {
    if (s.lng < bbox.west || s.lng > bbox.east) return false;
    if (s.lat < bbox.south || s.lat > bbox.north) return false;
    if (filter?.network && s.network !== filter.network) return false;
    if (filter?.type && !s.types.includes(filter.type)) return false;
    return true;
  });
}
