import { createPlace, fetchJson, USER_AGENT } from "@openmapx/core";
import {
  captureCacheWriter,
  dataSourceToAttribution,
  type IntegrationContext,
  scalarQueries,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import {
  createTileProxyHandler,
  tileBoundsWebMercator,
  type WebMercatorTileCoordinates,
} from "@openmapx/integration-framework/tile-proxy";
import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import type { ContributingRecord } from "@openmapx/mobility-core/contributors";
import {
  findNearestStation,
  loadStations as loadNoaaStations,
  type NoaaStationType,
} from "@openmapx/noaa-coops-data";
import { registerPlaceResolver } from "@openmapx/place-ids";
import manifest from "./manifest.json";
import {
  dedupTideStations,
  loadAllTideStations,
  type MergedTideStation,
  stationsInBbox as queryMergedInBbox,
  stationContributors,
  type TideNetwork,
  type TideStationCapability,
} from "./stations";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HARBOUR_LIST_BYTES = 2 * 1024 * 1024;
/** The harbour list is JSONP from a PHP endpoint; its declared type varies. */
const HARBOUR_LIST_MEDIA_TYPES = [
  "text/plain",
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
];
const SEAMARK_CACHE_TTL = 24 * 60 * 60; // 24h — OpenSeaMap tiles refresh daily
const DEPTH_CONTOUR_CACHE_TTL = 7 * 24 * 60 * 60; // 7d — contour data is very stable
const DEPTH_RELIEF_CACHE_TTL = 30 * 24 * 60 * 60; // 30d — GEBCO updates yearly
const NOAA_CACHE_TTL = 7 * 24 * 60 * 60; // 7d — NOAA updates charts weekly
const HARBORS_CACHE_TTL = 6 * 60 * 60; // 6h — harbour list rarely changes
const HARBOR_DETAIL_CACHE_TTL = 24 * 60 * 60; // 24h — facilities are static

const NOAA_WMS_LAYER = "0"; // Default NOAAChartDisplay MapServer layer.

const STATIONS_CACHE_TTL = 7 * 24 * 60 * 60; // 7d — matches the catalog refresh window

const NOAA_STATION_TYPES = new Set<NoaaStationType>([
  "tide-predictions",
  "water-level",
  "currents",
  "currents-predictions",
]);

/** Rank for marker styling — tide stations rank highest. */
const _STATION_TYPE_RANK: Record<NoaaStationType, number> = {
  "tide-predictions": 0,
  "water-level": 1,
  currents: 2,
  "currents-predictions": 3,
};

/**
 * GeoJSON properties shape for the merged multi-network station feed.
 *
 * `network` lets the click handler pick the right place scheme
 * (`coops`, `ca-iwls`, `kartverket`, `pegel`, `emodnet`, `ioc`) and lets the
 * legend color markers by network.
 */
interface StationFeatureProperties {
  _mapAttributions?: string;
  network: TideNetwork;
  id: string;
  name: string;
  /** Two-letter country code, when known. */
  country?: string;
  /** Primary capability the marker advertises. */
  primaryType: TideStationCapability;
  hasTide: boolean;
  hasWaterLevel: boolean;
  hasCurrents: boolean;
  /** Render priority — tide > water-level > currents. */
  rank: number;
}

interface StationFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: StationFeatureProperties;
  }>;
}

const CAPABILITY_RANK: Record<TideStationCapability, number> = {
  "tide-predictions": 0,
  "water-level": 1,
  currents: 2,
};

function parseStationTypes(raw: string | undefined): NoaaStationType[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim() as NoaaStationType)
    .filter((s) => NOAA_STATION_TYPES.has(s));
  return list.length > 0 ? list : undefined;
}

const HARBOR_TYPE_BY_CATEGORY: Record<number, string> = {
  1: "port",
  2: "port",
  3: "yacht_harbour",
  4: "marina",
  5: "anchorage",
  6: "fishing",
};

interface HarborFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number;
    name: string;
    lng: number;
    lat: number;
    category: number;
    type: string;
    wikiUrl?: string;
  };
}

interface HarborCollection {
  type: "FeatureCollection";
  features: HarborFeature[];
}

interface HarborDetail extends ContributingRecord {
  harbor: HarborFeature["properties"];
  facilities: Array<{
    osmId: string;
    seamarkType: string;
    name?: string;
    lat: number;
    lng: number;
    tags: Record<string, string>;
  }>;
  /**
   * NOAA tide-prediction station nearest to the harbor, within 5 km. The
   * place panel uses this to surface a tides row without a second lookup.
   * Undefined when the harbor is outside US tidal waters.
   */
  nearestTideStation?: ContributingRecord & {
    id: string;
    name: string;
    distanceKm: number;
  };
}

/** WMS 1.1.1 names the projection `srs`; 1.3.0 names it `crs`. */
function wmsTileUrl(
  base: string,
  tile: WebMercatorTileCoordinates,
  params: { version: "1.1.1" | "1.3.0"; layers: string; format: string; transparent: boolean },
): string {
  const [minX, minY, maxX, maxY] = tileBoundsWebMercator(tile);
  const url = new URL(base);
  url.searchParams.set("service", "WMS");
  url.searchParams.set("version", params.version);
  url.searchParams.set("request", "GetMap");
  url.searchParams.set("layers", params.layers);
  url.searchParams.set("styles", "");
  url.searchParams.set(params.version === "1.1.1" ? "srs" : "crs", "EPSG:3857");
  url.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
  url.searchParams.set("width", "256");
  url.searchParams.set("height", "256");
  url.searchParams.set("format", params.format);
  if (params.transparent) url.searchParams.set("transparent", "TRUE");
  return url.toString();
}

export function parseHarbourJsonp(text: string): HarborFeature[] {
  // Format: `putHarbourMarker(id, lng, lat, name, wikiUrl, category);` per line.
  const re =
    /putHarbourMarker\(\s*(\d+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*\)/g;
  const features: HarborFeature[] = [];
  for (const match of text.matchAll(re)) {
    const id = Number.parseInt(match[1], 10);
    const lng = Number.parseFloat(match[2]);
    const lat = Number.parseFloat(match[3]);
    const name = match[4].trim();
    const wikiUrl = match[5].trim();
    const category = Number.parseInt(match[6], 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        id,
        name: name || `Harbour ${id}`,
        lng,
        lat,
        category,
        type: HARBOR_TYPE_BY_CATEGORY[category] ?? "harbour",
        wikiUrl: wikiUrl || undefined,
      },
    });
  }
  return features;
}

interface OverpassResponse {
  elements: Array<{
    type: "node" | "way" | "relation";
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }>;
  remark?: string;
}

type HarborSurroundings = Pick<HarborDetail, "facilities" | "nearestTideStation">;

/** Facilities around a harbour position and the NOAA tide station nearest to it. */
async function fetchHarborSurroundings(
  ctx: IntegrationContext,
  lat: number,
  lng: number,
): Promise<{ surroundings: HarborSurroundings; complete: boolean }> {
  // Facilities + nearest-tide-station lookups run in parallel — the
  // station catalog is Redis-cached for a week so the second leg is cheap.
  const [facilities, tide] = await Promise.all([
    fetchHarborFacilities(ctx, lat, lng),
    (async (): Promise<{ station: HarborSurroundings["nearestTideStation"]; ok: boolean }> => {
      try {
        const credits = stationContributors("noaa");
        const stations = await loadNoaaStations(ctx.http, ctx.cache, ctx.log, undefined, credits);
        // The NOAA loader answers [] when its feeds fail; the real catalog is never empty.
        if (stations.length === 0) return { station: undefined, ok: false };
        const hit = findNearestStation(stations, lat, lng, 5, "tide-predictions");
        if (!hit) return { station: undefined, ok: true };
        return {
          station: {
            id: hit.station.id,
            name: hit.station.name,
            distanceKm: Number(hit.distanceKm.toFixed(2)),
            contributors: snapshotContributors(hit.station.contributors ?? credits),
          },
          ok: true,
        };
      } catch {
        return { station: undefined, ok: false };
      }
    })(),
  ]);
  return {
    surroundings: { facilities: facilities ?? [], nearestTideStation: tide.station },
    complete: facilities !== null && tide.ok,
  };
}

/** Seamark facilities around a position, or `null` when the Overpass lookup failed. */
async function fetchHarborFacilities(
  ctx: IntegrationContext,
  lat: number,
  lng: number,
): Promise<HarborDetail["facilities"] | null> {
  const overpass = ctx.getRequiredService("overpass");
  if (!overpass) return [];

  const query = `[out:json][timeout:15];
(
  node["seamark:type"="small_craft_facility"](around:500,${lat},${lng});
  node["seamark:type"="berth"](around:500,${lat},${lng});
  node["seamark:type"="mooring"](around:500,${lat},${lng});
  node["seamark:type"="bunker_station"](around:500,${lat},${lng});
  node["amenity"="fuel"]["seamark:type"](around:500,${lat},${lng});
);
out body;`;

  const upstream = overpass.url.endsWith("/interpreter")
    ? overpass.url
    : `${overpass.url.replace(/\/$/, "")}/api/interpreter`;

  const data = await fetchJson<OverpassResponse>(upstream, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    nullOnError: true,
    init: { method: "POST", body: `data=${encodeURIComponent(query)}` },
  });
  // Overpass reports a timeout or memory limit with a 200 and a `remark`, over
  // elements that may be cut short: no answer.
  if (!data || data.remark) return null;
  const facilities: HarborDetail["facilities"] = [];
  for (const el of data.elements) {
    if (el.type !== "node") continue;
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (elLat === undefined || elLng === undefined) continue;
    const tags = el.tags ?? {};
    const seamarkType = tags["seamark:type"] ?? "";
    facilities.push({
      osmId: `node/${el.id}`,
      seamarkType,
      name: tags.name ?? tags["seamark:name"],
      lat: elLat,
      lng: elLng,
      tags,
    });
  }
  return facilities;
}

export function setup(ctx: IntegrationContext): void {
  const seamarkBase =
    (ctx.config.seamarkTileBase as string | undefined)?.replace(/\/$/, "") ??
    "https://tiles.openseamap.org/seamark";
  const depthWmsUrl =
    (ctx.config.depthWmsUrl as string | undefined) ??
    "https://depth.openseamap.org/geoserver/openseamap/wms";
  const gebcoWmsUrl =
    (ctx.config.gebcoWmsUrl as string | undefined) ?? "https://wms.gebco.net/mapserv";
  const noaaWmsUrl =
    (ctx.config.noaaWmsUrl as string | undefined) ??
    "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer";
  const kartverketWmsUrl =
    (ctx.config.kartverketWmsUrl as string | undefined) ??
    "https://wms.geonorge.no/skwms1/wms.sjokartraster2";
  const kartverketLayer = (ctx.config.kartverketLayer as string | undefined) ?? "all";
  const harbourApiUrl =
    (ctx.config.harbourApiUrl as string | undefined) ??
    "https://harbour.openseamap.org/getHarbours.php";

  const tileProxy = (
    label: string,
    url: (tile: WebMercatorTileCoordinates) => string,
    cache: { key: (tile: WebMercatorTileCoordinates) => string; ttlSeconds: number },
    cacheControl: string,
    fallbackContentType = "image/png",
  ) =>
    createTileProxyHandler(ctx, {
      kind: "raster",
      label,
      url,
      ySuffix: ".png",
      timeoutMs: FETCH_TIMEOUT_MS,
      fallbackContentType,
      cacheControl,
      cache,
    });

  ctx.registerRoute(
    "GET",
    "/seamark/:z/:x/:y",
    tileProxy(
      "Seamark tile",
      ({ z, x, y }) => `${seamarkBase}/${z}/${x}/${y}.png`,
      { key: ({ z, x, y }) => `seamark:${z}:${x}:${y}`, ttlSeconds: SEAMARK_CACHE_TTL },
      "public, max-age=86400, s-maxage=86400",
    ),
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute(
    "GET",
    "/depth/contour/:z/:x/:y",
    tileProxy(
      "Depth contour tile",
      (tile) =>
        wmsTileUrl(depthWmsUrl, tile, {
          version: "1.1.1",
          layers: "openseamap:contour,openseamap:contour2",
          format: "image/png",
          transparent: true,
        }),
      { key: ({ z, x, y }) => `depth:contour:${z}:${x}:${y}`, ttlSeconds: DEPTH_CONTOUR_CACHE_TTL },
      "public, max-age=604800, s-maxage=604800",
    ),
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute(
    "GET",
    "/depth/relief/:z/:x/:y",
    tileProxy(
      "GEBCO relief tile",
      (tile) =>
        wmsTileUrl(gebcoWmsUrl, tile, {
          version: "1.3.0",
          layers: "GEBCO_LATEST",
          format: "image/jpeg",
          transparent: false,
        }),
      { key: ({ z, x, y }) => `depth:relief:${z}:${x}:${y}`, ttlSeconds: DEPTH_RELIEF_CACHE_TTL },
      "public, max-age=2592000, s-maxage=2592000",
      "image/jpeg",
    ),
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute(
    "GET",
    "/noaa/:z/:x/:y",
    tileProxy(
      "NOAA chart tile",
      (tile) =>
        wmsTileUrl(noaaWmsUrl, tile, {
          version: "1.3.0",
          layers: NOAA_WMS_LAYER,
          format: "image/png",
          transparent: true,
        }),
      { key: ({ z, x, y }) => `noaa:${z}:${x}:${y}`, ttlSeconds: NOAA_CACHE_TTL },
      "public, max-age=604800, s-maxage=604800",
    ),
    { rateLimitTier: "tile" },
  );

  // Kartverket Sjøkart 2 (Norway): free and commercial use under NLOD 2.0.
  // Coverage: Norway and Svalbard.
  ctx.registerRoute(
    "GET",
    "/charts/no/:z/:x/:y",
    tileProxy(
      "Kartverket chart tile",
      (tile) =>
        wmsTileUrl(kartverketWmsUrl, tile, {
          version: "1.3.0",
          layers: kartverketLayer,
          format: "image/png",
          transparent: true,
        }),
      { key: ({ z, x, y }) => `charts:no:${z}:${x}:${y}`, ttlSeconds: NOAA_CACHE_TTL },
      "public, max-age=604800, s-maxage=604800",
    ),
    { rateLimitTier: "tile" },
  );

  // ---- Harbour list (JSONP → GeoJSON) ------------------------------------
  ctx.registerRoute("GET", "/harbors", async (req, reply) => {
    const south = Number.parseFloat(scalarQueries(req.query).south ?? "");
    const north = Number.parseFloat(scalarQueries(req.query).north ?? "");
    const west = Number.parseFloat(scalarQueries(req.query).west ?? "");
    const east = Number.parseFloat(scalarQueries(req.query).east ?? "");
    const zoom = Number.parseInt(scalarQueries(req.query).zoom ?? "10", 10);
    if (
      !Number.isFinite(south) ||
      !Number.isFinite(north) ||
      !Number.isFinite(west) ||
      !Number.isFinite(east) ||
      south > north
    ) {
      reply.status(400).send({ message: "Invalid bbox" });
      return;
    }
    const k4 = (n: number) => Math.round(n * 1000) / 1000;
    const cacheKey = `harbors:contributors-v1:${k4(south)},${k4(west)},${k4(north)},${k4(east)}:z${zoom}`;
    const cached = await ctx.cache.get<HarborCollection>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=1800");
      reply.send(cached);
      return;
    }

    const writer = await captureCacheWriter(ctx.cache);
    const url = new URL(harbourApiUrl);
    url.searchParams.set("b", String(south));
    url.searchParams.set("t", String(north));
    url.searchParams.set("l", String(west));
    url.searchParams.set("r", String(east));
    url.searchParams.set("zoom", String(zoom));

    let text: string;
    try {
      const res = await ctx.http.getText(url.toString(), {
        maxBytes: MAX_HARBOUR_LIST_BYTES,
        contentTypes: HARBOUR_LIST_MEDIA_TYPES,
        fallbackContentType: "text/plain",
        discardErrorBody: true,
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: req.signal,
      });
      if (res.status !== 200) throw new Error(`OpenSeaMap harbour list HTTP ${res.status}`);
      text = res.body;
    } catch {
      reply.status(502).send({ message: "Harbour list fetch failed" });
      return;
    }
    const receipts = snapshotContributors(
      manifest.dataSources.filter((s) => s.sourceId === "openseamap").map(dataSourceToAttribution),
    );
    const features = parseHarbourJsonp(text).map((f) => ({
      ...f,
      properties: { ...f.properties, _mapAttributions: serializeContributors(receipts) },
    }));
    const collection: HarborCollection = { type: "FeatureCollection", features };
    await writer.set(cacheKey, collection, HARBORS_CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=1800");
    reply.send(collection);
  });

  // ---- Harbour detail (Overpass-enriched) --------------------------------
  ctx.registerRoute("GET", "/harbor/:id", async (req, reply) => {
    const id = req.params.id;
    const lat = Number.parseFloat(scalarQueries(req.query).lat ?? "");
    const lng = Number.parseFloat(scalarQueries(req.query).lng ?? "");
    const nameParam = (scalarQueries(req.query).name ?? "").trim();
    const categoryParam = Number.parseInt(scalarQueries(req.query).category ?? "", 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Missing or invalid lat/lng" });
      return;
    }

    // The upstream lookups depend only on the position, so they are cached by
    // the rounded position they query. The id, name and category come from
    // the caller and go on a detached copy, never into the shared entry.
    const queryLat = Math.round(lat * 10_000) / 10_000;
    const queryLng = Math.round(lng * 10_000) / 10_000;
    const cacheKey = `harbor:surroundings-v1:${queryLat},${queryLng}`;
    let surroundings = await ctx.cache.get<HarborSurroundings>(cacheKey);
    let complete = true;
    if (!surroundings) {
      const writer = await captureCacheWriter(ctx.cache);
      const fetched = await fetchHarborSurroundings(ctx, queryLat, queryLng);
      surroundings = fetched.surroundings;
      complete = fetched.complete;
      // A failed lookup would hide facilities or the tide station for the whole TTL.
      if (complete) await writer.set(cacheKey, surroundings, HARBOR_DETAIL_CACHE_TTL);
    }
    const { facilities, nearestTideStation } = structuredClone(surroundings);

    const detail: HarborDetail = {
      harbor: {
        id: Number.parseInt(id, 10),
        name: nameParam || `Harbour ${id}`,
        lng,
        lat,
        category: Number.isFinite(categoryParam) ? categoryParam : 0,
        type:
          Number.isFinite(categoryParam) && categoryParam in HARBOR_TYPE_BY_CATEGORY
            ? HARBOR_TYPE_BY_CATEGORY[categoryParam]
            : "harbour",
      },
      facilities,
      nearestTideStation,
      contributors: snapshotContributors(
        facilities.length ? [OPENSTREETMAP_ATTRIBUTION] : [],
        nearestTideStation?.contributors ?? [],
      ),
    };

    reply.header("Cache-Control", complete ? "public, max-age=3600" : "no-store");
    reply.send(detail);
  });

  // ---- Tide / water-level / currents stations (viewport GeoJSON) ---------
  //
  // Merges six networks server-side: NOAA CO-OPS (US), DFO IWLS (Canada),
  // Kartverket Sehavnivå (Norway), WSV Pegelonline (Germany coastal),
  // EMODnet Physics (pan-Europe), IOC Sea Level Monitoring (global).
  // Stations within 500 m are deduped, keeping the higher-ranked network so
  // we don't double-render Halifax (NOAA + IWLS overlap) or Helgoland
  // (Pegel + IOC overlap). Each marker carries its `network` so the click
  // handler can route to the matching place-resolver scheme.
  //
  // Query params:
  //   `west`, `south`, `east`, `north` — bbox (required)
  //   `types` — `tide-predictions,water-level,currents` filter (optional)
  //   `networks` — `noaa,ca-iwls,...` filter (optional; defaults to all)
  ctx.registerRoute("GET", "/stations", async (req, reply) => {
    const west = Number.parseFloat(scalarQueries(req.query).west ?? "");
    const south = Number.parseFloat(scalarQueries(req.query).south ?? "");
    const east = Number.parseFloat(scalarQueries(req.query).east ?? "");
    const north = Number.parseFloat(scalarQueries(req.query).north ?? "");
    if (
      !Number.isFinite(west) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(north)
    ) {
      reply.status(400).send({ message: "west/south/east/north must be valid numbers" });
      return;
    }
    if (south < -90 || north > 90 || south > north) {
      reply.status(400).send({ message: "Invalid south/north range" });
      return;
    }

    const typeFilter = parseStationTypes(scalarQueries(req.query).types);
    const networkFilter = parseNetworks(scalarQueries(req.query).networks);
    const k4 = (n: number) => Math.round(n * 10000) / 10000;
    const cacheKey = [
      "stations:bbox-merged-contributors-v1",
      k4(west),
      k4(south),
      k4(east),
      k4(north),
      typeFilter?.join("|") ?? "*",
      networkFilter?.join("|") ?? "*",
    ].join(":");

    const cached = await ctx.cache.get<StationFeatureCollection>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

    const writer = await captureCacheWriter(ctx.cache);
    // Load NOAA via the existing typed loader; load non-NOAA networks via the
    // new merger module. Each catalog is Redis-cached for 7d behind its own key.
    const [noaa, extra] = await Promise.all([
      loadNoaaStations(ctx.http, ctx.cache, ctx.log, undefined, stationContributors("noaa")).then(
        // The NOAA loader answers [] when its feeds fail, and the real catalog is
        // never empty (the package also ignores an empty cached catalog).
        (stations) => ({ stations, available: stations.length > 0 }),
        (): { stations: Awaited<ReturnType<typeof loadNoaaStations>>; available: boolean } => ({
          stations: [],
          available: false,
        }),
      ),
      loadAllTideStations(ctx.cache, ctx.log, USER_AGENT).catch(
        (): { stations: MergedTideStation[]; unavailable: TideNetwork[] } => ({
          stations: [],
          unavailable: ["ioc", "emodnet", "ca-iwls", "kartverket", "pegel"],
        }),
      ),
    ]);
    // A merge missing a network that failed would hide its stations for the
    // whole TTL; serve it, but cache only a complete one.
    const complete = noaa.available && extra.unavailable.length === 0;

    // Normalise NOAA into the shared shape, then dedup across all networks.
    const noaaMerged: MergedTideStation[] = noaa.stations.map((s) => {
      const types: TideStationCapability[] = [];
      if (s.types.includes("tide-predictions")) types.push("tide-predictions");
      if (s.types.includes("water-level")) types.push("water-level");
      if (s.types.includes("currents") || s.types.includes("currents-predictions")) {
        types.push("currents");
      }
      return {
        contributors: snapshotContributors(s.contributors ?? []),
        network: "noaa",
        id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        types: types.length ? types : ["water-level"],
        country: "US",
      };
    });

    const merged = dedupTideStations([...noaaMerged, ...extra.stations]);
    const inBbox = queryMergedInBbox(merged, { west, south, east, north });

    // Type filter — applied after dedup so the per-type counts reflect what
    // actually renders.
    const typeStrings: TideStationCapability[] | undefined = typeFilter
      ? typeFilter.map(noaaTypeToCapability).filter((t): t is TideStationCapability => !!t)
      : undefined;
    const typeFiltered = typeStrings
      ? inBbox.filter((s) => s.types.some((t) => typeStrings.includes(t)))
      : inBbox;

    const networkFiltered = networkFilter
      ? typeFiltered.filter((s) => networkFilter.includes(s.network))
      : typeFiltered;

    // Cap output — at low zoom levels the merged catalog can ship thousands of
    // points which would crash the GeoJSON source.
    const MAX_FEATURES = 3000;
    const limited = networkFiltered.slice(0, MAX_FEATURES);

    const collection: StationFeatureCollection = {
      type: "FeatureCollection",
      features: limited.map((s) => {
        const primaryType = s.types.reduce(
          (best, t) => (CAPABILITY_RANK[t] < CAPABILITY_RANK[best] ? t : best),
          s.types[0],
        );
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lng, s.lat] },
          properties: {
            _mapAttributions: serializeContributors(s.contributors ?? []),
            network: s.network,
            id: s.id,
            name: s.name,
            country: s.country,
            // `state` kept undefined for non-NOAA networks; the NOAA-specific
            // attribution surface checks for its presence.
            primaryType,
            hasTide: s.types.includes("tide-predictions"),
            hasWaterLevel: s.types.includes("water-level"),
            hasCurrents: s.types.includes("currents"),
            rank: CAPABILITY_RANK[primaryType] ?? 99,
          },
        };
      }),
    };

    if (complete) await writer.set(cacheKey, collection, STATIONS_CACHE_TTL);
    reply.header("Cache-Control", complete ? "public, max-age=3600" : "no-store");
    reply.send(collection);
  });

  // (Helper for the route handler above)
  function noaaTypeToCapability(t: NoaaStationType): TideStationCapability | null {
    if (t === "tide-predictions") return "tide-predictions";
    if (t === "water-level") return "water-level";
    if (t === "currents" || t === "currents-predictions") return "currents";
    return null;
  }

  function parseNetworks(raw: string | undefined): TideNetwork[] | undefined {
    if (!raw) return undefined;
    const allowed: TideNetwork[] = ["noaa", "ca-iwls", "kartverket", "pegel", "emodnet", "ioc"];
    const out = raw
      .split(",")
      .map((s) => s.trim() as TideNetwork)
      .filter((s) => allowed.includes(s));
    return out.length ? out : undefined;
  }

  // ---- Place resolver for openseamap-harbour: schemes --------------------
  //
  // Clicking a harbor marker on the frontend uses
  // `createPlace({ primaryScheme: "openseamap-harbour", ... })`; deep links
  // and saved places then round-trip back through this resolver. We don't
  // have a bbox-free harbor lookup API, so we resolve to a coordinate-only
  // Place using the supplied lat/lng hint.
  registerPlaceResolver("openseamap-harbour", async (value, resolveCtx) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const lat = resolveCtx.lat;
    const lng = resolveCtx.lng;
    if (lat === undefined || lng === undefined) return null;
    return createPlace({
      primaryScheme: "openseamap-harbour",
      ids: { "openseamap-harbour": id },
      name: `Harbour ${id}`,
      address: "",
      coordinates: [lng, lat],
      category: "Harbour",
      rawCategory: "nautical/harbour",
    });
  });
}
