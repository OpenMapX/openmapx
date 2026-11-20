import { USER_AGENT } from "@openmapx/core";
import {
  captureCacheWriter,
  type HttpClient,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import {
  createTileProxyHandler,
  createUpstreamImageHandler,
} from "@openmapx/integration-framework/tile-proxy";
import { assertNoXmlEntityDeclarations } from "@openmapx/mobility-formats";
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

/** The document is about 6 MB; the ceiling leaves room for growth. */
const MAX_CAPABILITIES_BYTES = 24 * 1024 * 1024;

async function fetchAndParseCapabilities(http: HttpClient): Promise<Capabilities> {
  const res = await http.getText(CAPABILITIES_URL, {
    maxBytes: MAX_CAPABILITIES_BYTES,
    contentTypes: ["text/xml", "application/xml"],
    discardErrorBody: true,
    headers: { "User-Agent": USER_AGENT },
    timeoutMs: 30_000,
  });
  if (res.status !== 200) throw new Error(`GetCapabilities fetch failed: ${res.status}`);

  const xml = res.body;
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    attributeNamePrefix: "@_",
  });
  // Keep fast-xml-parser's default value coercion while applying the shared entity guard.
  assertNoXmlEntityDeclarations(xml);
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
  captureCacheWriter(ctx.cache)
    .then(async (writer) =>
      writer.set(
        CAPABILITIES_CACHE_KEY,
        await fetchAndParseCapabilities(ctx.http),
        CAPABILITIES_CACHE_TTL,
      ),
    )
    .catch(() => {});

  ctx.registerRoute("GET", "/capabilities", async (_req, reply) => {
    const cached = await ctx.cache.get<Capabilities>(CAPABILITIES_CACHE_KEY);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

    try {
      const writer = await captureCacheWriter(ctx.cache);
      const capabilities = await fetchAndParseCapabilities(ctx.http);
      await writer.set(CAPABILITIES_CACHE_KEY, capabilities, CAPABILITIES_CACHE_TTL);
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(capabilities);
    } catch {
      reply.status(502).send({ message: "GetCapabilities unavailable" });
    }
  });

  ctx.registerRoute(
    "GET",
    "/legends/:filename",
    createUpstreamImageHandler(ctx, {
      kind: "raster",
      label: "NASA GIBS legend",
      url: ({ params }) =>
        /^[\w-]+\.png$/.test(params.filename ?? "")
          ? `https://gibs.earthdata.nasa.gov/legends/${params.filename}`
          : null,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: FETCH_TIMEOUT_MS,
      fallbackContentType: "image/png",
      cacheControl: "public, max-age=604800, s-maxage=604800",
    }),
  );

  ctx.registerRoute(
    "GET",
    "/tiles/:layerId/:date/:z/:y/:x",
    createTileProxyHandler(ctx, {
      kind: "raster",
      label: "NASA GIBS tile",
      url: ({ z, x, y }, { params }) => {
        const layer = GIBS_LAYER_BY_ID.get(params.layerId as GibsLayerId);
        if (!layer || !DATE_RE.test(params.date ?? "") || z > layer.maxZoom) return null;
        return (
          `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.identifier}` +
          `/default/${params.date}/${layer.tileMatrixSet}/${z}/${y}/${x}.${layer.format}`
        );
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      fallbackContentType: ({ params }) =>
        GIBS_LAYER_BY_ID.get(params.layerId as GibsLayerId)?.format === "jpg"
          ? "image/jpeg"
          : "image/png",
      cacheControl: ({ params }) => {
        const today = new Date().toISOString().slice(0, 10);
        const maxAge = (params.date ?? "") < today ? 86400 : 3600;
        return `public, max-age=${maxAge}, s-maxage=${maxAge}`;
      },
    }),
    { rateLimitTier: "tile" },
  );
}
