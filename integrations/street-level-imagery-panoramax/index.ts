import {
  captureStreetLevelProviderContributors,
  filterImagesByHeading,
  type IntegrationContext,
  parseStreetLevelSearchQuery,
  scalarQueries,
} from "@openmapx/integration-framework";
import { createTileProxyHandler } from "@openmapx/integration-framework/tile-proxy";
import { createPanoramaxProvider } from "./provider.js";

const DEFAULT_INSTANCE_URL = "https://api.panoramax.xyz/api";
const TILE_PATH = "/api/integrations/street-level-imagery-panoramax/tiles/{z}/{x}/{y}";

/**
 * Upstream failures (timeout, rate-limit, 5xx) are reported as 502, never as a
 * 404. Answering "no imagery here" for a transient blip is a lie the caller
 * cannot distinguish from genuine absence, and it is the kind of lie that gets
 * cached and reasoned about downstream.
 */
async function upstream<T>(
  ctx: IntegrationContext,
  reply: { status: (code: number) => { send: (data: unknown) => void } },
  what: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    ctx.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    reply.status(502).send({ error: `${what} is unavailable` });
    return { ok: false };
  }
}

export function setup(ctx: IntegrationContext): void {
  const instanceUrl = (ctx.config.instanceUrl as string | undefined) || DEFAULT_INSTANCE_URL;
  const provider = captureStreetLevelProviderContributors(
    ctx,
    createPanoramaxProvider({ instanceUrl, tileUrlTemplate: TILE_PATH }),
    "panoramax",
  );

  ctx.registerStreetLevelProvider(provider);

  ctx.registerRoute("GET", "/capabilities", async (_req, reply) => {
    reply.send(provider.capabilities());
  });

  ctx.registerRoute(
    "GET",
    "/tiles/:z/:x/:y",
    createTileProxyHandler(ctx, {
      kind: "vector",
      label: "Panoramax vector tile",
      url: ({ z, x, y }) => `${instanceUrl.replace(/\/$/, "")}/map/${z}/${x}/${y}.mvt`,
      maxZoom: 15,
      // A viewport change fans out 30-60 tile requests of hundreds of KB each;
      // 10 s regularly overran on the public instances and coverage went missing.
      timeoutMs: 25_000,
      fallbackContentType: "application/vnd.mapbox-vector-tile",
      cacheControl: "public, max-age=86400, s-maxage=86400",
    }),
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute("GET", "/nearest", async (req, reply) => {
    const lat = Number((scalarQueries(req.query) as { lat?: string }).lat);
    const lng = Number((scalarQueries(req.query) as { lng?: string }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "Invalid coordinates" });
      return;
    }

    const found = await upstream(ctx, reply, "Panoramax imagery search", () =>
      provider.findNearest([lng, lat]),
    );
    if (!found.ok) return;
    const image = found.value;
    if (!image) {
      reply.status(404).send({ error: "No imagery found near this location" });
      return;
    }
    reply.send(image);
  });

  ctx.registerRoute("GET", "/images/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await upstream(ctx, reply, "Panoramax imagery", () => provider.getImage(id));
    if (!found.ok) return;
    const image = found.value;
    if (!image) {
      reply.status(404).send({ error: "Image not found" });
      return;
    }
    reply.send(image);
  });

  ctx.registerRoute("GET", "/images/:id/links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await upstream(ctx, reply, "Panoramax imagery links", () =>
      provider.getLinks(id),
    );
    if (!found.ok) return;
    reply.send(found.value);
  });

  // Searchable surface for the navigation photo prefetch. Panoramax's fov
  // tolerance means "sees the point", not "faces the bearing", and the bbox
  // fallback has no heading filter at all — so the route applies the heading
  // filter itself, for both modes.
  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const parsed = parseStreetLevelSearchQuery(scalarQueries(req.query));
    if (!parsed) {
      reply.status(400).send({ error: "Invalid search query" });
      return;
    }
    const found = await upstream(ctx, reply, "Panoramax imagery search", () =>
      provider.searchImages({
        lngLat: parsed.lngLat,
        radiusM: parsed.radiusM,
        ...(parsed.heading !== undefined ? { heading: parsed.heading } : {}),
        headingToleranceDeg: parsed.headingToleranceDeg,
        ...(parsed.capturedAfter ? { capturedAfter: parsed.capturedAfter } : {}),
        ...(parsed.lookingAt ? { lookingAt: parsed.lookingAt } : {}),
        limit: parsed.limit,
      }),
    );
    if (!found.ok) return;
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(filterImagesByHeading(found.value, parsed.heading, parsed.headingToleranceDeg));
  });
}
