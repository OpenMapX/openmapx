import { createPlace, USER_AGENT } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import {
  findNearestStation,
  loadStations as loadNoaaStations,
  type NoaaStationType,
} from "@openmapx/noaa-coops-data";
import { registerPlaceResolver } from "@openmapx/place-ids";
import {
  dedupTideStations,
  loadAllTideStations,
  type MergedTideStation,
  stationsInBbox as queryMergedInBbox,
  type TideNetwork,
  type TideStationCapability,
} from "./stations";

const FETCH_TIMEOUT_MS = 15_000;
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
  network: TideNetwork;
  id: string;
  name: string;
  /** Two-letter country code, when known. */
  country?: string;
  /** NOAA-only — US state code, kept for backward compat with the place-panel attribution row. */
  state?: string;
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

interface HarborDetail {
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
  nearestTideStation?: {
    id: string;
    name: string;
    distanceKm: number;
  };
}

/** Convert XYZ tile to EPSG:3857 bbox (left, bottom, right, top in meters). */
function tileToWebMercatorBbox(z: number, x: number, y: number): [number, number, number, number] {
  const EARTH_CIRCUMFERENCE = 40075016.685578488;
  const halfCircumference = EARTH_CIRCUMFERENCE / 2;
  const resolution = EARTH_CIRCUMFERENCE / 2 ** z;
  const minX = -halfCircumference + x * resolution;
  const maxX = minX + resolution;
  const maxY = halfCircumference - y * resolution;
  const minY = maxY - resolution;
  return [minX, minY, maxX, maxY];
}

function parseTileParams(req: {
  params: Record<string, string>;
}): { z: number; x: number; y: number } | null {
  const z = Number.parseInt(req.params.z, 10);
  const x = Number.parseInt(req.params.x, 10);
  const yRaw = req.params.y?.replace(/\.png$/, "");
  const y = Number.parseInt(yRaw ?? "", 10);
  if (
    !Number.isFinite(z) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    z < 0 ||
    z > 22 ||
    x < 0 ||
    y < 0
  ) {
    return null;
  }
  return { z, x, y };
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

async function fetchAndCacheTile(
  ctx: IntegrationContext,
  cacheKey: string,
  ttl: number,
  upstreamUrl: string,
): Promise<Buffer | null> {
  const cached = await ctx.cache.get<{ data: string }>(cacheKey);
  if (cached?.data) {
    return Buffer.from(cached.data, "base64");
  }
  const res = await fetchWithTimeout(upstreamUrl);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  await ctx.cache.set(cacheKey, { data: buf.toString("base64") }, ttl);
  return buf;
}

function parseHarbourJsonp(text: string): HarborFeature[] {
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
}

async function fetchHarborFacilities(
  ctx: IntegrationContext,
  lat: number,
  lng: number,
): Promise<HarborDetail["facilities"]> {
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

  const res = await fetchWithTimeout(upstream, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res?.ok) return [];
  const data = (await res.json()) as OverpassResponse;
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

  // ---- Seamark tile proxy -------------------------------------------------
  ctx.registerRoute("GET", "/seamark/:z/:x/:y", async (req, reply) => {
    const params = parseTileParams(req);
    if (!params) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }
    const { z, x, y } = params;
    const cacheKey = `seamark:${z}:${x}:${y}`;
    const upstream = `${seamarkBase}/${z}/${x}/${y}.png`;
    const buf = await fetchAndCacheTile(ctx, cacheKey, SEAMARK_CACHE_TTL, upstream);
    if (!buf) {
      reply.status(502).send({ message: "Seamark tile fetch failed" });
      return;
    }
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.send(buf);
  });

  // ---- Depth contour tile proxy (OpenSeaMap WMS) -------------------------
  ctx.registerRoute("GET", "/depth/contour/:z/:x/:y", async (req, reply) => {
    const params = parseTileParams(req);
    if (!params) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }
    const { z, x, y } = params;
    const [minX, minY, maxX, maxY] = tileToWebMercatorBbox(z, x, y);
    const wmsUrl = new URL(depthWmsUrl);
    wmsUrl.searchParams.set("service", "WMS");
    wmsUrl.searchParams.set("version", "1.1.1");
    wmsUrl.searchParams.set("request", "GetMap");
    wmsUrl.searchParams.set("layers", "openseamap:contour,openseamap:contour2");
    wmsUrl.searchParams.set("styles", "");
    wmsUrl.searchParams.set("srs", "EPSG:3857");
    wmsUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    wmsUrl.searchParams.set("width", "256");
    wmsUrl.searchParams.set("height", "256");
    wmsUrl.searchParams.set("format", "image/png");
    wmsUrl.searchParams.set("transparent", "TRUE");

    const cacheKey = `depth:contour:${z}:${x}:${y}`;
    const buf = await fetchAndCacheTile(ctx, cacheKey, DEPTH_CONTOUR_CACHE_TTL, wmsUrl.toString());
    if (!buf) {
      reply.status(502).send({ message: "Depth contour tile fetch failed" });
      return;
    }
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.send(buf);
  });

  // ---- Depth relief tile proxy (GEBCO WMS) -------------------------------
  ctx.registerRoute("GET", "/depth/relief/:z/:x/:y", async (req, reply) => {
    const params = parseTileParams(req);
    if (!params) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }
    const { z, x, y } = params;
    const [minX, minY, maxX, maxY] = tileToWebMercatorBbox(z, x, y);
    const wmsUrl = new URL(gebcoWmsUrl);
    wmsUrl.searchParams.set("service", "WMS");
    wmsUrl.searchParams.set("version", "1.3.0");
    wmsUrl.searchParams.set("request", "GetMap");
    wmsUrl.searchParams.set("layers", "GEBCO_LATEST");
    wmsUrl.searchParams.set("styles", "");
    wmsUrl.searchParams.set("crs", "EPSG:3857");
    wmsUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    wmsUrl.searchParams.set("width", "256");
    wmsUrl.searchParams.set("height", "256");
    wmsUrl.searchParams.set("format", "image/jpeg");

    const cacheKey = `depth:relief:${z}:${x}:${y}`;
    const cached = await ctx.cache.get<{ data: string; contentType: string }>(cacheKey);
    if (cached?.data) {
      reply.header("Content-Type", cached.contentType);
      reply.header("Cache-Control", "public, max-age=2592000, s-maxage=2592000");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.send(Buffer.from(cached.data, "base64"));
      return;
    }
    const res = await fetchWithTimeout(wmsUrl.toString());
    if (!res?.ok) {
      reply.status(502).send({ message: "GEBCO tile fetch failed" });
      return;
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    await ctx.cache.set(
      cacheKey,
      { data: buf.toString("base64"), contentType },
      DEPTH_RELIEF_CACHE_TTL,
    );
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "public, max-age=2592000, s-maxage=2592000");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.send(buf);
  });

  // ---- NOAA Maritime Chart Service tile proxy ---------------------------
  ctx.registerRoute("GET", "/noaa/:z/:x/:y", async (req, reply) => {
    const params = parseTileParams(req);
    if (!params) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }
    const { z, x, y } = params;
    const [minX, minY, maxX, maxY] = tileToWebMercatorBbox(z, x, y);
    const wmsUrl = new URL(noaaWmsUrl);
    wmsUrl.searchParams.set("service", "WMS");
    wmsUrl.searchParams.set("version", "1.3.0");
    wmsUrl.searchParams.set("request", "GetMap");
    wmsUrl.searchParams.set("layers", NOAA_WMS_LAYER);
    wmsUrl.searchParams.set("styles", "");
    wmsUrl.searchParams.set("crs", "EPSG:3857");
    wmsUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    wmsUrl.searchParams.set("width", "256");
    wmsUrl.searchParams.set("height", "256");
    wmsUrl.searchParams.set("format", "image/png");
    wmsUrl.searchParams.set("transparent", "TRUE");

    const cacheKey = `noaa:${z}:${x}:${y}`;
    const buf = await fetchAndCacheTile(ctx, cacheKey, NOAA_CACHE_TTL, wmsUrl.toString());
    if (!buf) {
      reply.status(502).send({ message: "NOAA chart tile fetch failed" });
      return;
    }
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.send(buf);
  });

  // ---- Kartverket Sjøkart 2 (Norway) ------------------------------------
  // Free + commercial use under NLOD 2.0. Coverage: Norway + Svalbard.
  ctx.registerRoute("GET", "/charts/no/:z/:x/:y", async (req, reply) => {
    const params = parseTileParams(req);
    if (!params) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }
    const { z, x, y } = params;
    const [minX, minY, maxX, maxY] = tileToWebMercatorBbox(z, x, y);
    const wmsUrl = new URL(kartverketWmsUrl);
    wmsUrl.searchParams.set("service", "WMS");
    wmsUrl.searchParams.set("version", "1.3.0");
    wmsUrl.searchParams.set("request", "GetMap");
    wmsUrl.searchParams.set("layers", kartverketLayer);
    wmsUrl.searchParams.set("styles", "");
    wmsUrl.searchParams.set("crs", "EPSG:3857");
    wmsUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    wmsUrl.searchParams.set("width", "256");
    wmsUrl.searchParams.set("height", "256");
    wmsUrl.searchParams.set("format", "image/png");
    wmsUrl.searchParams.set("transparent", "TRUE");

    const cacheKey = `charts:no:${z}:${x}:${y}`;
    const buf = await fetchAndCacheTile(ctx, cacheKey, NOAA_CACHE_TTL, wmsUrl.toString());
    if (!buf) {
      reply.status(502).send({ message: "Kartverket chart tile fetch failed" });
      return;
    }
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.send(buf);
  });

  // ---- Harbour list (JSONP → GeoJSON) ------------------------------------
  ctx.registerRoute("GET", "/harbors", async (req, reply) => {
    const south = Number.parseFloat(req.query.south ?? "");
    const north = Number.parseFloat(req.query.north ?? "");
    const west = Number.parseFloat(req.query.west ?? "");
    const east = Number.parseFloat(req.query.east ?? "");
    const zoom = Number.parseInt(req.query.zoom ?? "10", 10);
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
    const cacheKey = `harbors:${k4(south)},${k4(west)},${k4(north)},${k4(east)}:z${zoom}`;
    const cached = await ctx.cache.get<HarborCollection>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=1800");
      reply.send(cached);
      return;
    }

    const url = new URL(harbourApiUrl);
    url.searchParams.set("b", String(south));
    url.searchParams.set("t", String(north));
    url.searchParams.set("l", String(west));
    url.searchParams.set("r", String(east));
    url.searchParams.set("zoom", String(zoom));

    const res = await fetchWithTimeout(url.toString());
    if (!res?.ok) {
      reply.status(502).send({ message: "Harbour list fetch failed" });
      return;
    }
    const text = await res.text();
    const features = parseHarbourJsonp(text);
    const collection: HarborCollection = { type: "FeatureCollection", features };
    await ctx.cache.set(cacheKey, collection, HARBORS_CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=1800");
    reply.send(collection);
  });

  // ---- Harbour detail (Overpass-enriched) --------------------------------
  ctx.registerRoute("GET", "/harbor/:id", async (req, reply) => {
    const id = req.params.id;
    const lat = Number.parseFloat(req.query.lat ?? "");
    const lng = Number.parseFloat(req.query.lng ?? "");
    const nameParam = (req.query.name ?? "").trim();
    const categoryParam = Number.parseInt(req.query.category ?? "", 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Missing or invalid lat/lng" });
      return;
    }

    const cacheKey = `harbor:${id}`;
    const cached = await ctx.cache.get<HarborDetail>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

    // Facilities + nearest-tide-station lookups run in parallel — the
    // station catalog is Redis-cached for a week so the second leg is cheap.
    const [facilities, nearestTideStation] = await Promise.all([
      fetchHarborFacilities(ctx, lat, lng),
      (async () => {
        try {
          const stations = await loadNoaaStations(ctx.cache, ctx.log);
          const hit = findNearestStation(stations, lat, lng, 5, "tide-predictions");
          if (!hit) return undefined;
          return {
            id: hit.station.id,
            name: hit.station.name,
            distanceKm: Number(hit.distanceKm.toFixed(2)),
          };
        } catch {
          return undefined;
        }
      })(),
    ]);

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
    };

    await ctx.cache.set(cacheKey, detail, HARBOR_DETAIL_CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=3600");
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
    const west = Number.parseFloat(req.query.west ?? "");
    const south = Number.parseFloat(req.query.south ?? "");
    const east = Number.parseFloat(req.query.east ?? "");
    const north = Number.parseFloat(req.query.north ?? "");
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

    const typeFilter = parseStationTypes(req.query.types);
    const networkFilter = parseNetworks(req.query.networks);
    const k4 = (n: number) => Math.round(n * 10000) / 10000;
    const cacheKey = [
      "stations:bbox-merged-v2",
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

    // Load NOAA via the existing typed loader; load non-NOAA networks via the
    // new merger module. Each catalog is Redis-cached for 7d behind its own key.
    const [noaaRaw, extraRaw] = await Promise.all([
      loadNoaaStations(ctx.cache, ctx.log).catch(() => []),
      loadAllTideStations(ctx.cache, ctx.log, USER_AGENT).catch(() => []),
    ]);

    // Normalise NOAA into the shared shape, then dedup across all networks.
    const noaaMerged: MergedTideStation[] = noaaRaw.map((s) => {
      const types: TideStationCapability[] = [];
      if (s.types.includes("tide-predictions")) types.push("tide-predictions");
      if (s.types.includes("water-level")) types.push("water-level");
      if (s.types.includes("currents") || s.types.includes("currents-predictions")) {
        types.push("currents");
      }
      return {
        network: "noaa",
        id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        types: types.length ? types : ["water-level"],
        country: "US",
      };
    });

    const merged = dedupTideStations([...noaaMerged, ...extraRaw]);
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
            network: s.network,
            id: s.id,
            name: s.name,
            country: s.country,
            // `state` kept undefined for non-NOAA networks; the NOAA-specific
            // attribution surface checks for its presence.
            state: undefined,
            primaryType,
            hasTide: s.types.includes("tide-predictions"),
            hasWaterLevel: s.types.includes("water-level"),
            hasCurrents: s.types.includes("currents"),
            rank: CAPABILITY_RANK[primaryType] ?? 99,
          },
        };
      }),
    };

    await ctx.cache.set(cacheKey, collection, STATIONS_CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=3600");
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
