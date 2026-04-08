import type { IntegrationContext } from "@openmapx/core";
import { XMLParser } from "fast-xml-parser";
import { type Capabilities, GIBS_LAYERS, type GibsLayerId } from "./store";

const FETCH_TIMEOUT_MS = 15_000;

// Derive lookup maps from the single source of truth in store.ts
const GIBS_LAYER_BY_ID = new Map<GibsLayerId, (typeof GIBS_LAYERS)[number]>(
  GIBS_LAYERS.map((l) => [l.id, l]),
);
const GIBS_ID_TO_KEY = new Map(GIBS_LAYERS.map((l) => [l.identifier, l.id]));

const CAPABILITIES_CACHE_KEY = "satellite:capabilities";
const CAPABILITIES_CACHE_TTL = 21_600; // 6 hours
const CAPABILITIES_URL =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&request=GetCapabilities";

async function fetchAndParseCapabilities(): Promise<Capabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const res = await fetch(CAPABILITIES_URL, {
    headers: { "User-Agent": "OpenMapX/1.0" },
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!res.ok) throw new Error(`GetCapabilities fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml);

  const layers = parsed?.Capabilities?.Contents?.Layer;
  if (!Array.isArray(layers)) throw new Error("Unexpected GetCapabilities structure");

  const result: Capabilities = {};

  for (const layer of layers) {
    const identifier = layer.Identifier;
    const internalKey = GIBS_ID_TO_KEY.get(identifier);
    if (!internalKey) continue;

    const dimension = layer.Dimension;
    if (!dimension) continue;

    const defaultDate: string = dimension.Default;
    const values = Array.isArray(dimension.Value) ? dimension.Value : [dimension.Value];
    const firstValue = String(values[0] ?? "");
    const startDate = firstValue.split("/")[0];

    if (!defaultDate || !startDate) continue;

    // Extract horizontal legend filename from Style > LegendURL
    // Use PNG instead of SVG — the SVGs contain embedded scripts that browsers
    // block when loaded via <img>, rendering them blank.
    let legend: string | undefined;
    const style = layer.Style;
    if (style) {
      const legendUrls = Array.isArray(style.LegendURL)
        ? style.LegendURL
        : style.LegendURL
          ? [style.LegendURL]
          : [];
      const horizontal = legendUrls.find((l: Record<string, string>) =>
        l["@_role"]?.includes("horizontal"),
      );
      const href: string | undefined = horizontal?.["@_href"];
      if (href) {
        legend = href
          .split("/")
          .pop()
          ?.replace(/\.svg$/, ".png");
      }
    }

    result[internalKey] = { defaultDate, startDate, legend };
  }

  return result;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function setup(ctx: IntegrationContext): void {
  // Pre-warm capabilities cache on startup
  fetchAndParseCapabilities()
    .then((caps) => ctx.cache.set(CAPABILITIES_CACHE_KEY, caps, CAPABILITIES_CACHE_TTL))
    .catch(() => {});

  ctx.registerRoute("GET", "/capabilities", async (_req, reply) => {
    const cached = await ctx.cache.get<Capabilities>(CAPABILITIES_CACHE_KEY);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

    try {
      const capabilities = await fetchAndParseCapabilities();
      await ctx.cache.set(CAPABILITIES_CACHE_KEY, capabilities, CAPABILITIES_CACHE_TTL);
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(capabilities);
    } catch {
      reply.status(502).send({ message: "GetCapabilities unavailable" });
    }
  });

  ctx.registerRoute("GET", "/legends/:filename", async (req, reply) => {
    const { filename } = req.params as Record<string, string>;
    if (!/^[\w-]+\.png$/.test(filename)) {
      reply.status(400).send({ message: "Invalid filename" });
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`https://gibs.earthdata.nasa.gov/legends/${filename}`, {
        headers: { "User-Agent": "OpenMapX/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        reply.status(res.status).send({ message: "Legend fetch failed" });
        return;
      }

      reply.header("Content-Type", "image/png");
      reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.send(Buffer.from(await res.arrayBuffer()));
    } catch {
      reply.status(502).send({ message: "Legend fetch failed" });
    }
  });

  ctx.registerRoute("GET", "/tiles/:layerId/:date/:z/:y/:x", async (req, reply) => {
    const { layerId, date, z, y, x } = req.params as Record<string, string>;

    const layer = GIBS_LAYER_BY_ID.get(layerId as GibsLayerId);
    if (!layer) {
      reply.status(400).send({ message: "Invalid layer" });
      return;
    }

    if (!DATE_RE.test(date)) {
      reply.status(400).send({ message: "Invalid date format" });
      return;
    }

    const tileUrl =
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.identifier}` +
      `/default/${date}/${layer.tileMatrixSet}/${z}/${y}/${x}.${layer.format}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const tileRes = await fetch(tileUrl, {
        headers: { "User-Agent": "OpenMapX/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!tileRes.ok) {
        reply.status(tileRes.status).send({ message: "Tile fetch failed" });
        return;
      }

      const contentType = layer.format === "jpg" ? "image/jpeg" : "image/png";
      const today = new Date().toISOString().slice(0, 10);
      const maxAge = date < today ? 86400 : 3600;

      reply.header("Content-Type", contentType);
      reply.header("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge}`);
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.send(Buffer.from(await tileRes.arrayBuffer()));
    } catch {
      reply.status(502).send({ message: "Tile fetch failed" });
    }
  });
}
