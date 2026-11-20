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
 * No API key is required. IOC data/products are offered for non-commercial use;
 * commercial use requires permission from the relevant data originators,
 * unverified for this operator. Other networks retain their own terms.
 *
 * Dedup priority when stations overlap within ~500m, highest first:
 *   NOAA > Canada (IWLS) > Norway (Kartverket) > Pegelonline > EMODnet > IOC
 *
 * National hydrographic offices outrank EMODnet/IOC because they hold the
 * authoritative tide-prediction harmonics; EMODnet outranks IOC because it
 * normalises its data through national QC pipelines.
 */
import { fetchJson, haversineKm } from "@openmapx/core";
import {
  type CacheClient,
  type ContributingRecord,
  captureCacheWriter,
  dataSourceToAttribution,
  type HttpClient,
  type Logger,
  snapshotContributors,
  withContributors,
} from "@openmapx/integration-framework";
import { loadIwlsStations } from "@openmapx/integration-knowledge-tides-canada/catalog";
import { loadIocStations } from "@openmapx/integration-knowledge-tides-ioc/catalog";
import { loadKartverketStations } from "@openmapx/integration-knowledge-tides-norway/catalog";
import { loadPegelonlineStations } from "@openmapx/integration-knowledge-tides-pegelonline/catalog";
import manifest from "./manifest.json";

export function stationContributors(network: TideNetwork) {
  const ids: Record<TideNetwork, string> = {
    noaa: "noaa-co-ops",
    "ca-iwls": "dfo-iwls",
    kartverket: "kartverket-sehavniva",
    pegel: "wsv-pegelonline",
    emodnet: "emodnet-physics",
    ioc: "ioc-sealevel",
  };
  return snapshotContributors(
    manifest.dataSources.filter((s) => s.sourceId === ids[network]).map(dataSourceToAttribution),
  );
}

export type TideNetwork = "noaa" | "ca-iwls" | "kartverket" | "pegel" | "emodnet" | "ioc";

export type TideStationCapability = "tide-predictions" | "water-level" | "currents";

export interface MergedTideStation extends ContributingRecord {
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

type CatalogStation = Omit<MergedTideStation, "network" | "contributors">;

/**
 * One network's catalog, cached for a week with its contributors. A failed
 * load is logged and rejects, so the merged answer names the network as
 * unavailable instead of caching an empty list.
 */
async function loadNetwork(
  network: TideNetwork,
  label: string,
  cache: CacheClient,
  log: Logger,
  load: () => Promise<CatalogStation[]>,
): Promise<MergedTideStation[]> {
  const cacheKey = `catalog:contributors-v1:${network}`;
  const cached = await cache.get<MergedTideStation[]>(cacheKey);
  if (cached) return cached;
  const writer = await captureCacheWriter(cache);
  let stations: CatalogStation[];
  try {
    stations = await load();
  } catch (error) {
    log.warn(`${label} station list unavailable`);
    throw error;
  }
  const captured = stations.map((station) =>
    withContributors({ ...station, network }, stationContributors(network)),
  );
  await writer.set(cacheKey, captured, CATALOG_TTL);
  return captured;
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
  return loadNetwork("emodnet", "EMODnet", cache, log, async () => {
    const raw = await fetchJsonWithTimeout<{ features: EmodnetFeature[] }>(EMODNET_WFS_URL, ua);
    if (!raw?.features) throw new Error("EMODnet station list unavailable");
    const stations: CatalogStation[] = [];
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
        id: code,
        name: code, // EMODnet doesn't ship a friendly name on this layer
        lat: lat as number,
        lng: lng as number,
        types: ["water-level"],
      });
    }
    return stations;
  });
}

// -------- Top-level: load everything in parallel + dedup -----------------
/** The merged non-NOAA catalogs, and the networks whose catalog could not be loaded. */
export interface TideStationCatalogs {
  stations: MergedTideStation[];
  unavailable: TideNetwork[];
}

export async function loadAllTideStations(
  http: HttpClient,
  cache: CacheClient,
  log: Logger,
  ua: string,
): Promise<TideStationCatalogs> {
  const loaders: Array<[TideNetwork, () => Promise<MergedTideStation[]>]> = [
    [
      "ioc",
      () =>
        loadNetwork("ioc", "IOC", cache, log, async () =>
          (await loadIocStations(http)).map((station) => ({
            id: station.code,
            name: station.name,
            lat: station.lat,
            lng: station.lng,
            // IOC publishes observations only (no harmonic predictions in the API).
            types: ["water-level"],
            country: iso3to2(station.country),
          })),
        ),
    ],
    ["emodnet", () => loadEmodnetStations(cache, log, ua)],
    [
      "ca-iwls",
      () =>
        loadNetwork("ca-iwls", "IWLS", cache, log, async () =>
          (await loadIwlsStations(http)).map((station) => {
            const codes = new Set(station.timeSeries);
            const types: TideStationCapability[] = [];
            if (codes.has("wlp") || codes.has("wlp-hilo")) types.push("tide-predictions");
            if (codes.has("wlo")) types.push("water-level");
            if (codes.has("wcs1") || codes.has("wcd1")) types.push("currents");
            return {
              // The stable IWLS id round-trips through the data endpoint.
              id: station.id,
              name: station.name,
              lat: station.lat,
              lng: station.lng,
              types: types.length ? types : ["water-level"],
              country: "CA",
            };
          }),
        ),
    ],
    [
      "kartverket",
      () =>
        loadNetwork("kartverket", "Kartverket", cache, log, async () =>
          (await loadKartverketStations(http)).map((station) => ({
            id: station.code,
            name: station.name,
            lat: station.lat,
            lng: station.lng,
            // Kartverket publishes predictions and observations for every permanent station.
            types: ["tide-predictions", "water-level"],
            country: "NO",
          })),
        ),
    ],
    [
      "pegel",
      () =>
        loadNetwork("pegel", "Pegelonline", cache, log, async () =>
          (await loadPegelonlineStations(http)).map((station) => ({
            id: station.uuid,
            name: station.name,
            lat: station.lat,
            lng: station.lng,
            types: ["water-level"],
            country: "DE",
          })),
        ),
    ],
  ];
  const settled = await Promise.allSettled(loaders.map(([, load]) => load()));
  const stations: MergedTideStation[] = [];
  const unavailable: TideNetwork[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") stations.push(...result.value);
    else unavailable.push(loaders[i][0]);
  });
  return { stations, unavailable };
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
