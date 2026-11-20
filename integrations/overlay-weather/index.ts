import { USER_AGENT } from "@openmapx/core";
import {
  captureCacheWriter,
  type IntegrationContext,
  type RouteHandler,
  scalarQueries,
} from "@openmapx/integration-framework";
import { createTileProxyHandler } from "@openmapx/integration-framework/tile-proxy";

const FETCH_TIMEOUT_MS = 10_000;

export function canonicalizeRainViewerHost(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const isRainViewerHost = hostname === "rainviewer.com" || hostname.endsWith(".rainviewer.com");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isRainViewerHost
  ) {
    return null;
  }

  return url.origin;
}

export function buildRainViewerTileUrl(
  radarHost: string,
  framePath: string,
  z: string,
  x: string,
  y: string,
): string {
  const host = canonicalizeRainViewerHost(radarHost);
  if (!host) throw new Error("Invalid RainViewer host");

  const tileUrl = new URL(host);
  const path = framePath.startsWith("/") ? framePath : `/${framePath}`;
  tileUrl.pathname = `${path}/256/${z}/${x}/${y}/1/1_1.png`;
  return tileUrl.toString();
}

interface RadarFrame {
  time: number;
  path: string;
}

interface RadarMeta {
  host: string;
  past: RadarFrame[];
  nowcast: RadarFrame[];
}

const ALLOWED_OWM_LAYERS = [
  "temp_new",
  "clouds_new",
  "precipitation_new",
  "wind_new",
  "pressure_new",
];

export function setup(ctx: IntegrationContext): void {
  const owmApiKey = ctx.config.owmApiKey as string | undefined;

  // RainViewer is non-commercial-only (commercialUse: "no"). Honour the operator's
  // data-use policy by gating its proxied radar metadata + tiles at the source
  // level; OpenWeatherMap (commercialUse: "yes") under this same integration is
  // unaffected.
  const radarGated = async (): Promise<boolean> =>
    ((await ctx.getDisallowedSourceIds?.()) ?? new Set<string>()).has("rainviewer");

  // Send 451 and return true when RainViewer is policy-gated, so each radar route
  // guards with a single `if (await denyIfRadarGated(reply)) return;` (one message).
  const denyIfRadarGated = async (reply: Parameters<RouteHandler>[1]): Promise<boolean> => {
    if (!(await radarGated())) return false;
    reply.status(451).send({ message: "RainViewer radar disabled by data-use policy" });
    return true;
  };

  ctx.registerRoute("GET", "/radar/meta", async (_req, reply) => {
    if (await denyIfRadarGated(reply)) return;
    const cached = await ctx.cache.get<RadarMeta>("weather:radar:meta");
    if (cached) {
      const host = canonicalizeRainViewerHost(cached.host);
      if (host) {
        reply.send({ ...cached, host });
        return;
      }
      await ctx.cache.del("weather:radar:meta");
    }

    try {
      const writer = await captureCacheWriter(ctx.cache);
      const data = await ctx.http.get<{
        host: string;
        radar: { past: RadarFrame[]; nowcast: RadarFrame[] };
      }>("https://api.rainviewer.com/public/weather-maps.json", {
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      const host = canonicalizeRainViewerHost(data.host);
      if (!host) {
        reply.status(502).send({ message: "RainViewer unavailable" });
        return;
      }
      const meta: RadarMeta = {
        host,
        past: data.radar.past ?? [],
        nowcast: data.radar.nowcast ?? [],
      };
      await writer.set("weather:radar:meta", meta, 300);
      reply.send(meta);
    } catch {
      reply.status(502).send({ message: "RainViewer unavailable" });
    }
  });

  // The frame path is allowlisted against the cached metadata before the
  // handler for that host and frame is built.
  const radarTile = (radarHost: string, framePath: string) =>
    createTileProxyHandler(ctx, {
      kind: "raster",
      label: "RainViewer tile",
      url: ({ z, x, y }) =>
        buildRainViewerTileUrl(radarHost, framePath, String(z), String(x), String(y)),
      timeoutMs: FETCH_TIMEOUT_MS,
      fallbackContentType: "image/png",
      cacheControl: "public, max-age=300, s-maxage=300",
    });

  ctx.registerRoute(
    "GET",
    "/radar/tile/:z/:x/:y",
    async (req, reply) => {
      if (await denyIfRadarGated(reply)) return;
      const framePath = scalarQueries(req.query).path;
      if (!framePath) {
        reply.status(400).send({ message: "Missing path query parameter" });
        return;
      }

      const cached = await ctx.cache.get<RadarMeta>("weather:radar:meta");
      const radarHost = cached ? canonicalizeRainViewerHost(cached.host) : null;
      if (!cached || !radarHost) {
        reply.status(503).send({ message: "Radar metadata not available" });
        return;
      }

      const allowedPaths = [...cached.past, ...cached.nowcast].map((f) => f.path);
      if (!allowedPaths.includes(framePath)) {
        reply.status(400).send({ message: "Invalid radar frame path" });
        return;
      }

      await radarTile(radarHost, framePath)(req, reply);
    },
    { rateLimitTier: "tile" },
  );

  const owmTile = createTileProxyHandler(ctx, {
    kind: "raster",
    label: "OpenWeatherMap tile",
    url: ({ z, x, y }, req) => {
      const layer = req.params.layer;
      if (!owmApiKey || !layer || !ALLOWED_OWM_LAYERS.includes(layer)) return null;
      const url = new URL(`https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png`);
      url.searchParams.set("appid", owmApiKey);
      return url.toString();
    },
    timeoutMs: FETCH_TIMEOUT_MS,
    fallbackContentType: "image/png",
    cacheControl: "public, max-age=600, s-maxage=600",
  });

  ctx.registerRoute(
    "GET",
    "/tiles/:layer/:z/:x/:y.png",
    async (req, reply) => {
      if (!owmApiKey) {
        reply.status(503).send({ message: "OWM not configured" });
        return;
      }
      if (!ALLOWED_OWM_LAYERS.includes(req.params.layer ?? "")) {
        reply.status(400).send({ message: "Invalid layer" });
        return;
      }
      await owmTile(req, reply);
    },
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute("GET", "/config", async (_req, reply) => {
    reply.send({
      radar: !(await radarGated()),
      temperature: !!owmApiKey,
      clouds: !!owmApiKey,
      wind: !!owmApiKey,
      pressure: !!owmApiKey,
      precipitation: !!owmApiKey,
    });
  });
}
