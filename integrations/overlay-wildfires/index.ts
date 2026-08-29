import {
  type IntegrationContext,
  type RouteHandler,
  scalarQueries,
} from "@openmapx/integration-framework";
import { nifcOffsetForZoom, normalizeViewport } from "./bounds.js";
import { loadEffis } from "./effis.js";
import { type FirmsDayRange, type FirmsSource, firmsFreshTtlSeconds, loadFirms } from "./firms.js";
import { FIRMS_FETCHED_AT_HEADER, FIRMS_STALE_HEADER } from "./firms-response.js";
import { loadNifc } from "./nifc.js";
import { loadNoaaSmoke } from "./noaa-smoke.js";
import { loadWithFreshAndStaleCache } from "./source-cache.js";
import {
  type NormalizedViewport,
  type WildfireProvider,
  type WildfireProviderData,
  WildfireSourceError,
  type WildfireSourceFailureKind,
} from "./types.js";

export { csvToGeoJSON, parseAcqDateTime } from "./firms.js";

const DAY_RANGES: FirmsDayRange[] = [1, 2, 3];
const SOURCES: FirmsSource[] = ["VIIRS_SNPP_NRT", "MODIS_NRT"];
const SOURCE_CACHE = {
  nifc: { fresh: 300, stale: 86_400 },
  effis: { fresh: 1_800, stale: 172_800 },
  "noaa-hms": { fresh: 600, stale: 86_400 },
} as const;
const STALE_SOURCE_FAILURE_KINDS: readonly WildfireSourceFailureKind[] = [
  "upstream-status",
  "upstream-payload",
  "network",
  "timeout",
  "feature-cap",
];

type ViewportSource = "nifc" | "effis";
type RouteReply = Parameters<RouteHandler>[1];

function viewportCacheKey(source: ViewportSource, bounds: NormalizedViewport): string {
  const normalizedBounds = `${bounds.west}:${bounds.south}:${bounds.east}:${bounds.north}`;
  return source === "nifc"
    ? `wildfires:${source}:${normalizedBounds}:offset:${nifcOffsetForZoom(bounds.zoom)}`
    : `wildfires:${source}:${normalizedBounds}`;
}

function cacheControl(freshTtlSeconds: number): string {
  return `public, max-age=${freshTtlSeconds}, s-maxage=${freshTtlSeconds}`;
}

function unavailableReply(reply: RouteReply, code: string): void {
  reply.header("Cache-Control", "no-store");
  reply.status(503).send({ code });
}

function invalidViewportReply(reply: RouteReply): void {
  reply.header("Cache-Control", "no-store");
  reply.status(400).send({ message: "Invalid viewport" });
}

function sourceFailureDetails(
  source: WildfireProvider,
  error: unknown,
): { kind: string; upstreamStatus?: number } | null {
  if (!(error instanceof WildfireSourceError) || error.provider !== source) return null;
  return {
    kind: error.kind,
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
  };
}

function shouldUseStaleSourceFailure(source: WildfireProvider, error: unknown): boolean {
  return (
    error instanceof WildfireSourceError &&
    error.provider === source &&
    STALE_SOURCE_FAILURE_KINDS.includes(error.kind)
  );
}

function sendCachedSource(
  reply: RouteReply,
  cache: { fresh: number },
  result: { value: WildfireProviderData; fetchedAt: string; stale: boolean },
): void {
  reply.header("Cache-Control", cacheControl(cache.fresh));
  reply.send({ ...result.value, fetchedAt: result.fetchedAt, stale: result.stale });
}

function viewportSourceHandler(
  ctx: IntegrationContext,
  source: ViewportSource,
  code: string,
  load: (ctx: IntegrationContext, bounds: NormalizedViewport) => Promise<WildfireProviderData>,
): RouteHandler {
  return async (req, reply) => {
    let bounds: NormalizedViewport;
    try {
      bounds = normalizeViewport(scalarQueries(req.query));
    } catch {
      invalidViewportReply(reply);
      return;
    }

    try {
      const result = await loadWithFreshAndStaleCache(ctx, {
        key: viewportCacheKey(source, bounds),
        freshTtlSeconds: SOURCE_CACHE[source].fresh,
        staleTtlSeconds: SOURCE_CACHE[source].stale,
        shouldUseStaleOnError: (error) => shouldUseStaleSourceFailure(source, error),
        load: () => load(ctx, bounds),
      });
      sendCachedSource(reply, SOURCE_CACHE[source], result);
    } catch (error) {
      const details = sourceFailureDetails(source, error);
      if (!details) throw error;
      ctx.log.warn("Wildfire source unavailable", { provider: source, ...details });
      unavailableReply(reply, code);
    }
  };
}

function noaaSmokeHandler(ctx: IntegrationContext): RouteHandler {
  const source = "noaa-hms" as const;
  return async (_req, reply) => {
    try {
      const result = await loadWithFreshAndStaleCache(ctx, {
        key: "wildfires:noaa-hms",
        freshTtlSeconds: SOURCE_CACHE[source].fresh,
        staleTtlSeconds: SOURCE_CACHE[source].stale,
        shouldUseStaleOnError: (error) => shouldUseStaleSourceFailure(source, error),
        load: () => loadNoaaSmoke(ctx),
      });
      sendCachedSource(reply, SOURCE_CACHE[source], result);
    } catch (error) {
      const details = sourceFailureDetails(source, error);
      if (!details) throw error;
      ctx.log.warn("Wildfire source unavailable", { provider: source, ...details });
      unavailableReply(reply, "noaa_hms_unavailable");
    }
  };
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/wildfires", async (req, reply) => {
    const dayRange = Number.parseInt(scalarQueries(req.query).dayRange ?? "1", 10);
    const source = scalarQueries(req.query).source ?? "VIIRS_SNPP_NRT";

    if (!DAY_RANGES.includes(dayRange as FirmsDayRange)) {
      reply.status(400).send({ message: "Invalid dayRange (1-3)" });
      return;
    }
    if (!SOURCES.includes(source as FirmsSource)) {
      reply.status(400).send({ message: "Invalid source" });
      return;
    }

    if (!ctx.config.firmsApiKey) {
      ctx.log.warn("FIRMS map key not configured");
      reply.status(503).send({ message: "Wildfire data not configured" });
      return;
    }

    try {
      const result = await loadFirms(ctx, {
        dayRange: dayRange as FirmsDayRange,
        source: source as FirmsSource,
      });
      reply.header("Cache-Control", cacheControl(firmsFreshTtlSeconds(dayRange as FirmsDayRange)));
      reply.header(FIRMS_FETCHED_AT_HEADER, result.fetchedAt);
      reply.header(FIRMS_STALE_HEADER, String(result.stale));
      reply.send(result.value);
    } catch (error) {
      ctx.log.error("Failed to fetch FIRMS data", error);
      reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
    }
  });

  ctx.registerRoute(
    "GET",
    "/perimeters/nifc",
    viewportSourceHandler(ctx, "nifc", "nifc_unavailable", loadNifc),
  );
  ctx.registerRoute(
    "GET",
    "/burned-areas/effis",
    viewportSourceHandler(ctx, "effis", "effis_unavailable", loadEffis),
  );
  ctx.registerRoute("GET", "/smoke/noaa", noaaSmokeHandler(ctx));
}
