import {
  fetchJson as coreFetchJson,
  createPlace,
  despikeSeries,
  findTideExtrema,
  type Place,
} from "@openmapx/core";
import {
  type ContributingRecord,
  createTidesIntegration,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
  type TideEvent,
  type TidesResponse,
  withContributors,
} from "@openmapx/integration-framework";

/**
 * Global tide-gauge observation knowledge integration. Wraps the IOC Sea
 * Level Station Monitoring Facility (UNESCO):
 *
 *  - `service.php?query=stationlist&format=json` — ~700 active gauges worldwide
 *  - `service.php?query=data&code=<station>&period=<days>` — observations
 *
 * IOC publishes observations only (no harmonic predictions). Its tide
 * response contains the current level, curve, and derived high/low events
 * from the past 24 h of observations. Forecast event sections self-hide
 * because the derived events all lie in the past.
 *
 * Units: `query=data` serves every sea-level sensor in metres; they are
 * converted to feet for parity with NOAA. The station list's `units` field
 * names the originator's unit, not the served one: for its 26 "F" stations
 * (mostly JMA radars) the served values sit on a 0.003048 m (0.01 ft) grid,
 * and their daily ranges match JMA's centimetre predictions read as metres.
 * Levels are the gauge's raw signal against the instrument's own unreferenced
 * zero, not a tidal datum: "We only deal with relative data, we don't have the vertical
 * datum information available" (https://www.ioc-sealevelmonitoring.org/service.php).
 * `stime` is UTC without a marker and is re-emitted with `Z`. The IOC policy
 * covers non-commercial use; commercial use requires the relevant data
 * originators' permission, which is not verified for this operator.
 *
 * The place-resolver + `/tides` route shell (nearest-station lookup, per-day
 * `nearest:` cache, `{ notFound: true }` sentinel, `Cache-Control`) lives in
 * the shared `createTidesIntegration` factory; everything below is the
 * IOC-specific catalog/observation handling.
 */
const BASE = "https://www.ioc-sealevelmonitoring.org/service.php";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 30 * 60; // observations refresh; predictions cache shorter
const MAX_STATION_DISTANCE_KM = 80; // IOC stations are sparse globally
const M_TO_FT = 3.28084;
const CACHE_GENERATION = "height-source-v1";

/**
 * Sensor codes that measure sea level, from IOC's sensor-type table
 * (https://github.com/SLSMF/API-Documentation/blob/main/API_description.md).
 * Stations also report battery voltage (`bat`), air pressure (`atm`) and
 * other non-sea-level channels in the same series. `prte` is left out because
 * IOC folds DART tsunami-event samples into `prt` and never prefers them.
 */
const SEA_LEVEL_SENSORS = new Set([
  "prs",
  "pr1",
  "pr2",
  "pr3",
  "rad",
  "ra2",
  "ra3",
  "ras",
  "enc",
  "enb",
  "en2",
  "aqu",
  "bub",
  "bub1",
  "ecs",
  "ec2",
  "wls",
  "pwl",
  "bwl",
  "flt",
  "stp",
  "prt",
]);

/**
 * IOC's preferred-sensor rule picks the sensor with the most good values and
 * breaks ties by type: "rad > ra2 > ra3 > prs > pr1 > pr2 > rest"
 * (https://github.com/SLSMF/API-Documentation/blob/main/research_data/Readme.md).
 */
const SENSOR_PREFERENCE = ["rad", "ra2", "ra3", "prs", "pr1", "pr2"];

function sensorRank(sensor: string): number {
  const rank = SENSOR_PREFERENCE.indexOf(sensor);
  return rank === -1 ? SENSOR_PREFERENCE.length : rank;
}

interface IocStationRaw {
  Code: string;
  Location: string;
  country?: string;
  Lat: number;
  Lon: number;
  status?: number;
  /** Originator's unit ("M", "F", "V"); `query=data` still serves metres. */
  units?: string;
}

interface IocDataPoint {
  slevel: number;
  stime: string; // "2026-05-17 22:30:00"
  sensor: string;
}

interface CachedStation extends ContributingRecord {
  code: string;
  name: string;
  lat: number;
  lng: number;
  country?: string;
}

export function reformatIocTime(stime: string): string {
  // IOC publishes `stime` in UTC without a TZ marker (e.g. "2026-05-17 22:30:00").
  // Convert to ISO-8601 with `Z` so the place-panel parser detects UTC and
  // renders the event in the viewer's browser-local zone. Returning the
  // space-separated form would land in the wall-clock branch and shift events
  // by the viewer's UTC offset.
  const m = stime.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return stime;
  return `${m[1]}T${m[2]}Z`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  return coreFetchJson<T>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    nullOnError: true,
    headers: { Accept: "application/json" },
  });
}

async function loadStations(ctx: IntegrationContext): Promise<CachedStation[]> {
  const cached = await ctx.cache.get<CachedStation[]>("catalog:contributors-v1");
  if (cached) return cached;
  const captured = resolveIntegrationContributors(ctx, ["ioc-sealevel"]);

  const raw = await fetchJson<IocStationRaw[]>(`${BASE}?query=stationlist&format=json`);
  if (!raw) {
    ctx.log.warn("IOC station list unavailable");
    return [];
  }
  const seen = new Set<string>();
  const stations: CachedStation[] = [];
  for (const s of raw) {
    if (s.status !== 1) continue;
    if (!Number.isFinite(s.Lat) || !Number.isFinite(s.Lon)) continue;
    if (seen.has(s.Code)) continue;
    seen.add(s.Code);
    stations.push({
      code: s.Code,
      name: s.Location.trim() || s.Code,
      lat: s.Lat,
      lng: s.Lon,
      country: s.country,
    });
  }
  const acquired = stations.map((station) => withContributors(station, captured));
  await ctx.cache.set("catalog:contributors-v1", acquired, CATALOG_TTL);
  return acquired;
}

export async function fetchObservations(stationCode: string): Promise<IocDataPoint[]> {
  // `period` is in days; 1 day = the last 24 h of observations.
  const url = `${BASE}?query=data&code=${encodeURIComponent(stationCode)}&format=json&period=1`;
  const raw = await fetchJson<IocDataPoint[]>(url);
  if (!raw) return [];
  const bySensor = new Map<string, IocDataPoint[]>();
  for (const p of raw) {
    if (!Number.isFinite(p.slevel) || !SEA_LEVEL_SENSORS.has(p.sensor)) continue;
    const list = bySensor.get(p.sensor) ?? [];
    list.push(p);
    bySensor.set(p.sensor, list);
  }
  let best: IocDataPoint[] = [];
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [sensor, list] of bySensor) {
    const rank = sensorRank(sensor);
    if (list.length > best.length || (list.length === best.length && rank < bestRank)) {
      best = list;
      bestRank = rank;
    }
  }
  return best.sort((a, b) => a.stime.localeCompare(b.stime));
}

/**
 * Derive past H/L events from the observation series (metres). Uses the shared
 * hysteresis detector so sensor noise / flat plateaus don't produce spurious
 * extrema. Threshold: 3 cm or 12 % of the observed range, whichever is larger.
 */
export function deriveExtrema(curve: Array<{ time: string; value: number }>): TideEvent[] {
  return findTideExtrema(curve, { minDelta: 0.03, relativeDelta: 0.12 }).map((e) => ({
    time: e.time,
    type: e.type,
    valueFt: Math.round(e.value * M_TO_FT * 100) / 100,
  }));
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const hourKey = new Date().toISOString().slice(0, 13);
  const cacheKey = `tides:${CACHE_GENERATION}:${station.code}:${hourKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) return cached;
  const captured = resolveIntegrationContributors(ctx, ["ioc-sealevel"]);

  const obs = await fetchObservations(station.code);
  if (obs.length === 0) return null;

  // IOC raw gauge data carries occasional spikes / sentinels (e.g. an exact
  // -1.0 m glitch); drop them before plotting or deriving extrema, since one
  // outlier corrupts the range, threshold and event list. 0.25 m is far beyond
  // any real tide change over the ~15 s sampling interval.
  const curveRaw = despikeSeries(
    obs.map((p) => ({ time: reformatIocTime(p.stime), value: p.slevel })),
    0.25,
  );
  const curve = curveRaw.map((p) => ({
    time: p.time,
    valueFt: Math.round(p.value * M_TO_FT * 100) / 100,
  }));

  const events = deriveExtrema(curveRaw);

  const last = curveRaw[curveRaw.length - 1];

  const result: TidesResponse = {
    contributors: snapshotContributors(station.contributors ?? [], captured),
    fieldContributors: {
      station: snapshotContributors(station.contributors ?? []),
      events: snapshotContributors(captured),
      curve: snapshotContributors(captured),
      currentLevel: snapshotContributors(captured),
    },
    station: {
      id: station.code,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      distanceKm: Number(distanceKm.toFixed(2)),
    },
    events,
    curve,
    datum: "sensor_reference",
    units: "english",
    timeZone: "iso_offset",
    heightSource: "observation",
    currentLevel: {
      time: last.time,
      valueFt: Math.round(last.value * M_TO_FT * 100) / 100,
    },
  };
  await ctx.cache.set(cacheKey, result, TIDES_TTL);
  return result;
}

export function setup(ctx: IntegrationContext): void {
  createTidesIntegration<CachedStation>(ctx, {
    scheme: "ioc",
    sourceId: "ioc-sealevel",
    loadStations,
    findStationById: (stations, id) => stations.find((s) => s.code === id),
    createPlace: (station): Place =>
      createPlace({
        primaryScheme: "ioc",
        ids: { ioc: station.code },
        name: station.name,
        contributors: snapshotContributors(station.contributors ?? []),
        address: "",
        coordinates: [station.lng, station.lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      }),
    buildTidesResponse,
    maxStationDistanceKm: MAX_STATION_DISTANCE_KM,
    nearestCacheTtl: TIDES_TTL,
    nearestCacheGeneration: CACHE_GENERATION,
    cacheControlMaxAge: 1800,
    unavailableMessage: "Observations unavailable",
  });
}
