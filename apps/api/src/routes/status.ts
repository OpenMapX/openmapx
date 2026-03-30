import { createConnection } from "node:net";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "../db/index.js";
import { redis } from "../redis.js";

const TIMEOUT = 5_000;
const UA = "OpenMapX/1.0 (+https://openmapx.org)";

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("timed out")) return "Timeout";
    const cause = err.cause as Record<string, string> | undefined;
    if (cause?.code === "ECONNREFUSED") return "Connection refused";
    if (cause?.code === "ENOTFOUND") return "DNS lookup failed";
    if (cause?.code === "ECONNRESET") return "Connection reset";
    const msg = err.message;
    return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  }
  return String(err).slice(0, 120);
}

function maskPassword(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:([^@/]+)@/, ":***@");
  }
}

/** Standard health check — 2xx = up, anything else = down. */
async function httpCheck(
  id: string,
  name: string,
  category: string,
  displayUrl: string,
  checkUrl: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const res = await fetch(checkUrl, {
      method: opts?.method ?? "GET",
      headers: { "User-Agent": UA, ...(opts?.headers ?? {}) },
      body: opts?.body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - start;
    if (res.ok) return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: ms,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

/** Connectivity check — any non-5xx response = up (server is running). */
async function pingCheck(
  id: string,
  name: string,
  category: string,
  displayUrl: string,
  checkUrl: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const res = await fetch(checkUrl, {
      method: opts?.method ?? "GET",
      headers: { "User-Agent": UA, ...(opts?.headers ?? {}) },
      body: opts?.body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - start;
    if (res.status < 500)
      return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: ms,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

function notConfigured(id: string, name: string, category: string, reason: string): ServiceStatus {
  return { id, name, category, url: reason, status: "unconfigured" };
}

// ── Infrastructure ──────────────────────────────────

async function checkPostgres(): Promise<ServiceStatus> {
  const raw = env("DATABASE_URL") ?? "postgresql://postgres:postgres@localhost:5432/openmapx";
  const display = maskPassword(raw);
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return {
      id: "postgresql",
      name: "PostgreSQL",
      category: "Infrastructure",
      url: display,
      status: "up",
      responseTime: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "postgresql",
      name: "PostgreSQL",
      category: "Infrastructure",
      url: display,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const url = env("REDIS_URL");
  if (!redis || !url) return notConfigured("redis", "Redis", "Infrastructure", "REDIS_URL not set");
  const start = Date.now();
  try {
    await redis.ping();
    return {
      id: "redis",
      name: "Redis",
      category: "Infrastructure",
      url,
      status: "up",
      responseTime: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "redis",
      name: "Redis",
      category: "Infrastructure",
      url,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

// ── Geocoding ───────────────────────────────────────

function checkNominatim() {
  const url = env("NOMINATIM_URL") ?? "https://nominatim.openstreetmap.org";
  return httpCheck("nominatim", "Nominatim", "Geocoding", url, `${url}/status`);
}

function checkPhoton() {
  const url = env("PHOTON_URL") ?? "https://photon.komoot.io";
  return httpCheck("photon", "Photon", "Geocoding", url, `${url}/api?q=a&limit=1`);
}

function checkPelias() {
  const url = env("PELIAS_URL") ?? "http://localhost:4000";
  return pingCheck("pelias", "Pelias", "Geocoding", url, `${url}/v1`);
}

function checkMapTilerGeocoding() {
  const key = env("MAPTILER_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured(
        "maptiler-geocoding",
        "MapTiler Geocoding",
        "Geocoding",
        "MAPTILER_KEY not set",
      ),
    );
  return httpCheck(
    "maptiler-geocoding",
    "MapTiler Geocoding",
    "Geocoding",
    "https://api.maptiler.com/geocoding",
    `https://api.maptiler.com/geocoding/test.json?key=${key}&limit=1`,
  );
}

// ── Routing ─────────────────────────────────────────

function checkOsrm() {
  const url = env("OSRM_URL") ?? "https://router.project-osrm.org";
  return httpCheck("osrm", "OSRM", "Routing", url, `${url}/nearest/v1/driving/13.388,52.517`);
}

function checkValhalla() {
  const url = env("VALHALLA_URL") ?? "https://valhalla1.openstreetmap.de";
  return pingCheck("valhalla", "Valhalla", "Routing", url, `${url}/status`);
}

// ── Transit ─────────────────────────────────────────

function checkTransitous() {
  const url = env("TRANSITOUS_URL") ?? "https://api.transitous.org";
  return pingCheck("transitous", "Transitous (MOTIS)", "Transit", url, url);
}

function checkMotisLocal() {
  const url = env("MOTIS_URL") ?? "http://localhost:8081";
  return pingCheck("motis-local", "MOTIS (self-hosted)", "Transit", url, url);
}

function checkOtp() {
  const url = env("OTP_URL") ?? "http://localhost:8090";
  return pingCheck("otp", "OpenTripPlanner", "Transit", url, `${url}/otp/routers/default`);
}

function checkHafas(id: string, name: string, baseUrl: string) {
  return pingCheck(`hafas-${id}`, name, "Transit", baseUrl, baseUrl);
}

function checkIRail() {
  return pingCheck(
    "irail",
    "iRail (Belgium)",
    "Transit",
    "https://api.irail.be",
    "https://api.irail.be/stations/?format=json",
  );
}

function checkOpendataCh() {
  const url = "https://transport.opendata.ch/v1";
  return httpCheck(
    "opendata-ch",
    "opendata.ch (Switzerland)",
    "Transit",
    url,
    `${url}/locations?query=a&type=station`,
  );
}

function checkTransitLand() {
  const key = env("TRANSIT_LAND_API_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("transitland", "Transit.Land", "Transit", "TRANSIT_LAND_API_KEY not set"),
    );
  const url = "https://transit.land/api/v2/rest";
  return httpCheck(
    "transitland",
    "Transit.Land",
    "Transit",
    url,
    `${url}/agencies?apikey=${key}&limit=1`,
  );
}

function checkTfl() {
  const key = env("TFL_API_KEY");
  if (!key)
    return Promise.resolve(notConfigured("tfl", "TfL (London)", "Transit", "TFL_API_KEY not set"));
  return httpCheck(
    "tfl",
    "TfL (London)",
    "Transit",
    "https://api.tfl.gov.uk",
    `https://api.tfl.gov.uk/Line/Mode/tube/Status?app_key=${key}`,
  );
}

function checkMbta() {
  const key = env("MBTA_API_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("mbta", "MBTA (Boston)", "Transit", "MBTA_API_KEY not set"),
    );
  return httpCheck(
    "mbta",
    "MBTA (Boston)",
    "Transit",
    "https://api-v3.mbta.com",
    `https://api-v3.mbta.com/routes?api_key=${key}&page%5Blimit%5D=1`,
  );
}

function checkDbRis() {
  const clientId = env("DB_RIS_CLIENT_ID");
  const apiKey = env("DB_RIS_API_KEY");
  if (!clientId || !apiKey)
    return Promise.resolve(
      notConfigured("db-ris", "DB RIS", "Transit", "DB_RIS credentials not set"),
    );
  const url = "https://apis.deutschebahn.com/db/apis/ris-stations/v1";
  return pingCheck(
    "db-ris",
    "DB RIS",
    "Transit",
    url,
    `${url}/stop-places/by-key?keyType=EVA&key=8000105`,
    {
      headers: {
        "DB-Client-ID": clientId,
        "DB-Api-Key": apiKey,
        Accept: "application/vnd.de.db.ris+json",
      },
    },
  );
}

// ── Map Tiles ───────────────────────────────────────

function checkMapTilerTiles() {
  const key = env("MAPTILER_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("maptiler-tiles", "MapTiler Tiles", "Map Tiles", "MAPTILER_KEY not set"),
    );
  return httpCheck(
    "maptiler-tiles",
    "MapTiler Tiles",
    "Map Tiles",
    "https://api.maptiler.com",
    `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`,
  );
}

function checkTileServerGl() {
  const url = env("TILESERVER_URL") ?? "http://localhost:8080";
  return pingCheck("tileserver-gl", "TileServer GL", "Map Tiles", url, `${url}/health`);
}

function checkMartin() {
  const url = env("MARTIN_URL") ?? "http://localhost:3002";
  return pingCheck("martin", "Martin", "Map Tiles", url, `${url}/catalog`);
}

function checkOpenTopoMap() {
  return httpCheck(
    "opentopomap",
    "OpenTopoMap",
    "Map Tiles",
    "https://tile.opentopomap.org",
    "https://tile.opentopomap.org/1/0/0.png",
  );
}

// ── Imagery ─────────────────────────────────────────

function checkMapillary() {
  const token = env("MAPILLARY_TOKEN");
  if (!token)
    return Promise.resolve(
      notConfigured("mapillary", "Mapillary", "Imagery", "MAPILLARY_TOKEN not set"),
    );
  return httpCheck(
    "mapillary",
    "Mapillary",
    "Imagery",
    "https://graph.mapillary.com",
    `https://graph.mapillary.com/images?access_token=${token}&fields=id&limit=1&bbox=0,0,0.001,0.001`,
  );
}

function checkFlickr() {
  const key = env("FLICKR_API_KEY");
  if (!key)
    return Promise.resolve(notConfigured("flickr", "Flickr", "Imagery", "FLICKR_API_KEY not set"));
  return httpCheck(
    "flickr",
    "Flickr",
    "Imagery",
    "https://api.flickr.com",
    `https://api.flickr.com/services/rest/?method=flickr.test.echo&api_key=${key}&format=json&nojsoncallback=1`,
  );
}

function checkPanoramax() {
  return httpCheck(
    "panoramax",
    "Panoramax",
    "Imagery",
    "https://api.panoramax.xyz",
    "https://api.panoramax.xyz/api/search?bbox=0,0,0.001,0.001&limit=1",
  );
}

function checkWikimediaPhotos() {
  return httpCheck(
    "wikimedia-photos",
    "Wikimedia Commons",
    "Imagery",
    "https://commons.wikimedia.org",
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&meta=siteinfo",
  );
}

// ── Traffic ─────────────────────────────────────────

function checkTomTom() {
  const key = env("TOMTOM_TRAFFIC_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("tomtom", "TomTom Traffic", "Traffic", "TOMTOM_TRAFFIC_KEY not set"),
    );
  const base = env("TOMTOM_TRAFFIC_URL") ?? "https://api.tomtom.com";
  return httpCheck(
    "tomtom",
    "TomTom Traffic",
    "Traffic",
    base,
    `${base}/traffic/map/4/tile/flow/relative-delay/12/2048/1361.png?key=${key}&tileSize=256`,
  );
}

// ── Data Overlays ───────────────────────────────────

function checkOpenAq() {
  const key = env("OPENAQ_API_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("openaq", "OpenAQ", "Data Overlays", "OPENAQ_API_KEY not set"),
    );
  return httpCheck(
    "openaq",
    "OpenAQ",
    "Data Overlays",
    "https://api.openaq.org/v3",
    "https://api.openaq.org/v3/locations?bbox=-0.1,-0.1,0.1,0.1&parameters_id=2&limit=1&page=1",
    {
      headers: { "X-API-Key": key },
    },
  );
}

function checkUsgsEarthquakes() {
  const url = "https://earthquake.usgs.gov";
  return httpCheck(
    "usgs-eq",
    "USGS Earthquakes",
    "Data Overlays",
    url,
    `${url}/earthquakes/feed/v1.0/summary/2.5_day.geojson`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
      },
    },
  );
}

function checkNasaFirms() {
  const key = env("FIRMS_MAP_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("firms", "NASA FIRMS", "Data Overlays", "FIRMS_MAP_KEY not set"),
    );
  return httpCheck(
    "firms",
    "NASA FIRMS",
    "Data Overlays",
    "https://firms.modaps.eosdis.nasa.gov",
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`,
  );
}

function checkOpenChargeMap() {
  const key = env("OPENCHARGEMAP_API_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured("ocm", "Open Charge Map", "Data Overlays", "OPENCHARGEMAP_API_KEY not set"),
    );
  return httpCheck(
    "ocm",
    "Open Charge Map",
    "Data Overlays",
    "https://api.openchargemap.io/v3",
    `https://api.openchargemap.io/v3/poi/?output=json&maxresults=1&key=${key}&latitude=0&longitude=0&distance=100`,
  );
}

function checkOverpass() {
  const rawUrl = env("OVERPASS_URL");
  const base = rawUrl ? rawUrl.replace(/\/$/, "") : "https://overpass-api.de";
  return httpCheck("overpass", "Overpass API", "Data Overlays", base, `${base}/api/interpreter`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=[out:json][timeout:3];node(0,0,0.001,0.001);out count;",
  });
}

function checkWaymarkedTrails() {
  return httpCheck(
    "waymarked",
    "Waymarked Trails",
    "Data Overlays",
    "https://hiking.waymarkedtrails.org/api/v1",
    "https://hiking.waymarkedtrails.org/api/v1/list/search?query=a&limit=1",
  );
}

// ── Parking ─────────────────────────────────────────

function checkParkApi() {
  return httpCheck(
    "parkapi",
    "ParkAPI (MobiData BW)",
    "Parking",
    "https://api.mobidata-bw.de",
    "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites?limit=1",
  );
}

function checkDbParking() {
  const clientId = env("DB_PARKING_CLIENT_ID");
  const apiKey = env("DB_PARKING_API_KEY");
  if (!clientId || !apiKey)
    return Promise.resolve(
      notConfigured("db-parking", "DB BahnPark", "Parking", "DB_PARKING credentials not set"),
    );
  return pingCheck(
    "db-parking",
    "DB BahnPark",
    "Parking",
    "https://apis.deutschebahn.com/db/apis/ris-stations/v1",
    "https://apis.deutschebahn.com/db/apis/ris-stations/v1/stop-places/by-key?keyType=EVA&key=8000105",
    {
      headers: {
        "DB-Client-ID": clientId,
        "DB-Api-Key": apiKey,
        Accept: "application/vnd.de.db.ris+json",
      },
    },
  );
}

// ── Shared Mobility ─────────────────────────────────

function checkNextbike() {
  return httpCheck(
    "nextbike",
    "Nextbike",
    "Shared Mobility",
    "https://maps.nextbike.net",
    "https://maps.nextbike.net/maps/nextbike-live.json?limit=0",
  );
}

function checkCambio() {
  return httpCheck(
    "cambio",
    "Cambio CarSharing",
    "Shared Mobility",
    "https://cwapi.cambio-carsharing.com",
    "https://cwapi.cambio-carsharing.com/pub/de-ac/stations",
  );
}

function checkDbGbfs() {
  const clientId = env("DB_GBFS_CLIENT_ID");
  const apiKey = env("DB_GBFS_API_KEY");
  if (!clientId || !apiKey)
    return Promise.resolve(
      notConfigured("db-gbfs", "DB GBFS", "Shared Mobility", "DB_GBFS credentials not set"),
    );
  return pingCheck(
    "db-gbfs",
    "DB GBFS",
    "Shared Mobility",
    "https://apis.deutschebahn.com/db-api-marketplace/apis/shared-mobility-gbfs/v2/de",
    "https://apis.deutschebahn.com/db-api-marketplace/apis/shared-mobility-gbfs/v2/de",
    {
      headers: { "DB-Client-ID": clientId, "DB-Api-Key": apiKey },
    },
  );
}

// ── Fuel Prices ─────────────────────────────────────

function checkTankerkoenig() {
  const key = env("TANKERKOENIG_API_KEY");
  if (!key)
    return Promise.resolve(
      notConfigured(
        "tankerkoenig",
        "Tankerkoenig (DE)",
        "Fuel Prices",
        "TANKERKOENIG_API_KEY not set",
      ),
    );
  return httpCheck(
    "tankerkoenig",
    "Tankerkoenig (DE)",
    "Fuel Prices",
    "https://creativecommons.tankerkoenig.de",
    `https://creativecommons.tankerkoenig.de/json/list.php?lat=52.52&lng=13.405&rad=1&sort=dist&type=all&apikey=${key}`,
  );
}

function checkFuelFrance() {
  return httpCheck(
    "fuel-france",
    "Prix Carburants (FR)",
    "Fuel Prices",
    "https://data.economie.gouv.fr",
    "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?limit=1",
  );
}

function checkFuelSpain() {
  return pingCheck(
    "fuel-spain",
    "Minetur (ES)",
    "Fuel Prices",
    "https://sedeaplicaciones.minetur.gob.es",
    "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/",
  );
}

function checkFuelAustria() {
  return httpCheck(
    "fuel-austria",
    "E-Control (AT)",
    "Fuel Prices",
    "https://api.e-control.at",
    "https://api.e-control.at/sprit/1.0/search/gas-stations/by-address?latitude=48.2082&longitude=16.3738&fuelType=DIE&includeClosed=false",
  );
}

// ── Enrichment ──────────────────────────────────────

function checkWikidata() {
  return httpCheck(
    "wikidata",
    "Wikidata",
    "Enrichment",
    "https://www.wikidata.org",
    "https://www.wikidata.org/w/api.php?action=query&format=json&meta=siteinfo",
  );
}

function checkWikipedia() {
  return httpCheck(
    "wikipedia",
    "Wikipedia",
    "Enrichment",
    "https://en.wikipedia.org",
    "https://en.wikipedia.org/api/rest_v1/page/summary/Main_Page",
  );
}

// ── External ────────────────────────────────────────

function checkGitHub() {
  const token = env("GITHUB_TOKEN");
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `token ${token}`;
  const label = token
    ? "https://api.github.com (authenticated)"
    : "https://api.github.com (unauthenticated)";
  return httpCheck("github", "GitHub API", "External", label, "https://api.github.com/rate_limit", {
    headers,
  });
}

async function checkSmtp(): Promise<ServiceStatus> {
  const host = env("SMTP_HOST");
  if (!host) return notConfigured("smtp", "SMTP", "External", "SMTP_HOST not set");
  const port = Number(env("SMTP_PORT") ?? 587);
  const url = `${host}:${port}`;
  const start = Date.now();
  return new Promise<ServiceStatus>((resolve) => {
    const socket = createConnection({ host, port, timeout: TIMEOUT }, () => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "up",
        responseTime: Date.now() - start,
      });
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "down",
        responseTime: Date.now() - start,
        error: errMsg(err),
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "down",
        responseTime: Date.now() - start,
        error: "Timeout",
      });
    });
  });
}

// ── Route ───────────────────────────────────────────

export const statusRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/status", async () => {
    const results = await Promise.all([
      // Infrastructure
      checkPostgres(),
      checkRedis(),
      // Geocoding
      checkNominatim(),
      checkPhoton(),
      checkPelias(),
      checkMapTilerGeocoding(),
      // Routing
      checkOsrm(),
      checkValhalla(),
      // Transit
      checkTransitous(),
      checkMotisLocal(),
      checkOtp(),
      checkHafas("db", "HAFAS (DB)", "https://v6.db.transport.rest"),
      checkHafas("vbb", "HAFAS (VBB)", "https://v6.vbb.transport.rest"),
      checkHafas("bvg", "HAFAS (BVG)", "https://v6.bvg.transport.rest"),
      checkIRail(),
      checkOpendataCh(),
      checkTransitLand(),
      checkTfl(),
      checkMbta(),
      checkDbRis(),
      // Map Tiles
      checkMapTilerTiles(),
      checkTileServerGl(),
      checkMartin(),
      checkOpenTopoMap(),
      // Imagery
      checkMapillary(),
      checkFlickr(),
      checkPanoramax(),
      checkWikimediaPhotos(),
      // Traffic
      checkTomTom(),
      // Data Overlays
      checkOpenAq(),
      checkUsgsEarthquakes(),
      checkNasaFirms(),
      checkOpenChargeMap(),
      checkOverpass(),
      checkWaymarkedTrails(),
      // Parking
      checkParkApi(),
      checkDbParking(),
      // Shared Mobility
      checkNextbike(),
      checkCambio(),
      checkDbGbfs(),
      // Fuel Prices
      checkTankerkoenig(),
      checkFuelFrance(),
      checkFuelSpain(),
      checkFuelAustria(),
      // Enrichment
      checkWikidata(),
      checkWikipedia(),
      // External
      checkGitHub(),
      checkSmtp(),
    ]);
    return { timestamp: new Date().toISOString(), services: results };
  });
};
