import { type IntegrationContext, USER_AGENT } from "@openmapx/core";

const FETCH_TIMEOUT_MS = 10_000;

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
  const owmApiKey = (ctx.config.OWM_API_KEY ?? ctx.config.owmApiKey) as string | undefined;

  ctx.registerRoute("GET", "/radar/meta", async (_req, reply) => {
    const cached = await ctx.cache.get<RadarMeta>("weather:radar:meta");
    if (cached) {
      reply.send(cached);
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        reply.status(502).send({ message: "RainViewer unavailable" });
        return;
      }
      const data = (await res.json()) as {
        host: string;
        radar: { past: RadarFrame[]; nowcast: RadarFrame[] };
      };
      const meta: RadarMeta = {
        host: data.host,
        past: data.radar.past ?? [],
        nowcast: data.radar.nowcast ?? [],
      };
      await ctx.cache.set("weather:radar:meta", meta, 300);
      reply.send(meta);
    } catch {
      reply.status(502).send({ message: "RainViewer unavailable" });
    }
  });

  ctx.registerRoute("GET", "/radar/tile/:z/:x/:y", async (req, reply) => {
    const framePath = req.query.path;
    if (!framePath) {
      reply.status(400).send({ message: "Missing path query parameter" });
      return;
    }

    const cached = await ctx.cache.get<RadarMeta>("weather:radar:meta");
    if (!cached) {
      reply.status(503).send({ message: "Radar metadata not available" });
      return;
    }

    const allowedPaths = [...cached.past, ...cached.nowcast].map((f) => f.path);
    if (!allowedPaths.includes(framePath as string)) {
      reply.status(400).send({ message: "Invalid radar frame path" });
      return;
    }

    const { z, x, y } = req.params as Record<string, string>;
    const tileUrl = `${cached.host}${framePath}/256/${z}/${x}/${y}/1/1_1.png`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const tileRes = await fetch(tileUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!tileRes.ok) {
        reply.status(tileRes.status).send({ message: "Radar tile fetch failed" });
        return;
      }

      reply.header("Content-Type", "image/png");
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.send(Buffer.from(await tileRes.arrayBuffer()));
    } catch {
      reply.status(502).send({ message: "Radar tile fetch failed" });
    }
  });

  ctx.registerRoute("GET", "/tiles/:layer/:z/:x/:y.png", async (req, reply) => {
    if (!owmApiKey) {
      reply.status(503).send({ message: "OWM not configured" });
      return;
    }

    const { layer, z, x, y } = req.params as Record<string, string>;
    if (!ALLOWED_OWM_LAYERS.includes(layer)) {
      reply.status(400).send({ message: "Invalid layer" });
      return;
    }

    try {
      const tileUrl = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${owmApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const tileRes = await fetch(tileUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!tileRes.ok) {
        reply.status(tileRes.status).send({ message: "Tile fetch failed" });
        return;
      }

      reply.header("Content-Type", "image/png");
      reply.header("Cache-Control", "public, max-age=600, s-maxage=600");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.send(Buffer.from(await tileRes.arrayBuffer()));
    } catch {
      reply.status(502).send({ message: "Tile fetch failed" });
    }
  });

  ctx.registerRoute("GET", "/config", async (_req, reply) => {
    reply.send({
      radar: true,
      temperature: !!owmApiKey,
      clouds: !!owmApiKey,
      wind: !!owmApiKey,
      pressure: !!owmApiKey,
      precipitation: !!owmApiKey,
    });
  });
}
