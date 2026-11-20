import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { USER_AGENT } from "@openmapx/core";
import {
  MAX_RASTER_TILE_BYTES,
  MAX_VECTOR_TILE_BYTES,
  RASTER_IMAGE_MEDIA_TYPES,
  VECTOR_TILE_MEDIA_TYPES,
} from "@openmapx/core/server";
import type { IntegrationContext, ResponseOptions, RouteHandler } from "./context";

export interface WebMercatorTileCoordinates {
  z: number;
  x: number;
  y: number;
}

const DECIMAL_INTEGER_RE = /^[0-9]+$/;

/** Decimal z/x/y inside the Web Mercator tile grid up to `maxZoom`, or null. */
export function parseWebMercatorTileCoordinates(
  z: string,
  x: string,
  y: string,
  maxZoom: number,
): WebMercatorTileCoordinates | null {
  if (![z, x, y].every((value) => DECIMAL_INTEGER_RE.test(value))) return null;

  const parsed = { z: Number(z), x: Number(x), y: Number(y) };
  if (![parsed.z, parsed.x, parsed.y, maxZoom].every(Number.isSafeInteger)) return null;
  if (maxZoom < 0 || parsed.z > maxZoom) return null;

  const worldWidth = 2 ** parsed.z;
  if (parsed.x >= worldWidth || parsed.y >= worldWidth) return null;
  return parsed;
}

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.685578488;

/** EPSG:3857 bounds of a tile as `[minX, minY, maxX, maxY]` in metres, for WMS `bbox`. */
export function tileBoundsWebMercator({
  z,
  x,
  y,
}: WebMercatorTileCoordinates): [number, number, number, number] {
  const half = EARTH_CIRCUMFERENCE_METERS / 2;
  const resolution = EARTH_CIRCUMFERENCE_METERS / 2 ** z;
  const minX = -half + x * resolution;
  const maxY = half - y * resolution;
  return [minX, maxY - resolution, minX + resolution, maxY];
}

type TileRequest = Parameters<RouteHandler>[0];
type TileReply = Parameters<RouteHandler>[1];

/** Shared by tile routes and fixed-path image routes. */
export interface UpstreamImageProxyOptions {
  /** Picks the media-type allowlist and default byte ceiling. */
  kind: "raster" | "vector";
  /** Names the upstream in error bodies and logs, e.g. "Waymarked Trails tile". */
  label: string;
  /** Cache-Control for a successful answer. */
  cacheControl: string | ((request: TileRequest) => string);
  /** Media type assumed when the upstream omits Content-Type. */
  fallbackContentType: string | ((request: TileRequest) => string);
  /** Request deadline including the body. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Lower byte ceiling than the kind's default. */
  maxBytes?: number;
  /** Extra upstream request headers. A User-Agent is always sent. */
  headers?: Record<string, string>;
  /** Upstream statuses that mean "no data here"; they answer 204 with this Cache-Control. */
  empty?: { statuses: readonly number[]; cacheControl: string };
  /**
   * Buffer the tile and keep it in the integration cache under this key. The
   * entry holds base64 bytes and the content type.
   */
  cache?: { key: (request: TileRequest) => string; ttlSeconds: number };
}

export interface TileProxyOptions extends Omit<UpstreamImageProxyOptions, "cache"> {
  /** Upstream URL for validated coordinates; null answers 400. */
  url: (tile: WebMercatorTileCoordinates, request: TileRequest) => string | null;
  /** Highest zoom accepted. Defaults to 22. */
  maxZoom?: number;
  /** Removed from the `y` path parameter when present, for routes such as `/:z/:x/:y` serving `5.png`. */
  ySuffix?: string;
  /** Integration cache key for a tile, enabling buffered mode. */
  cache?: { key: (tile: WebMercatorTileCoordinates) => string; ttlSeconds: number };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ZOOM = 22;

interface CachedTile {
  data: string;
  contentType: string;
}

class UpstreamTileStatus extends Error {
  constructor(readonly status: number) {
    super(`upstream answered HTTP ${status}`);
  }
}

function mediaType(header: string | undefined, fallback: string): string {
  return header?.split(";", 1)[0]?.trim().toLowerCase() || fallback;
}

function sendError(reply: TileReply, status: number, error: string): void {
  reply.status(status).send({ error });
}

/**
 * Proxy one upstream image or tile. Upstream 404 answers 404, the `empty`
 * statuses answer 204, and every other failure answers 502, so an upstream 401,
 * 403 or 429 never reaches the browser as if the caller had caused it. Logs
 * name the label and status but never the URL, because keys sit in queries.
 */
async function proxyUpstreamImage(
  ctx: IntegrationContext,
  request: TileRequest,
  reply: TileReply,
  url: string,
  options: UpstreamImageProxyOptions,
): Promise<void> {
  const contentTypes =
    options.kind === "raster" ? RASTER_IMAGE_MEDIA_TYPES : VECTOR_TILE_MEDIA_TYPES;
  const fallbackContentType =
    typeof options.fallbackContentType === "function"
      ? options.fallbackContentType(request)
      : options.fallbackContentType;
  const responseOptions = (signal: AbortSignal | undefined): ResponseOptions => ({
    maxBytes:
      options.maxBytes ??
      (options.kind === "raster" ? MAX_RASTER_TILE_BYTES : MAX_VECTOR_TILE_BYTES),
    contentTypes,
    fallbackContentType,
    responseHeaders: ["content-type"],
    discardErrorBody: true,
    headers: { "User-Agent": USER_AGENT, ...options.headers },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal,
  });
  const cacheControl = () =>
    typeof options.cacheControl === "function"
      ? options.cacheControl(request)
      : options.cacheControl;
  const succeed = (contentType: string) => {
    reply.header("Cache-Control", cacheControl());
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.type(contentType);
  };
  const answerStatus = (status: number) => {
    if (status === 204 || options.empty?.statuses.includes(status)) {
      reply.header("Cache-Control", options.empty?.cacheControl ?? cacheControl());
      reply.status(204).send(undefined);
    } else if (status === 404) {
      sendError(reply, 404, `${options.label} not found`);
    } else {
      ctx.log.warn(`${options.label} request failed: upstream HTTP ${status}`);
      sendError(reply, 502, `${options.label} unavailable`);
    }
  };
  const isTile = (status: number) => status >= 200 && status < 300 && status !== 204;

  try {
    if (options.cache) {
      const allowed: readonly string[] = contentTypes;
      const tile = await ctx.cache.withCache<CachedTile>(
        options.cache.key(request),
        options.cache.ttlSeconds,
        async (signal) => {
          // A stream, unlike getBytes, discards an error body without judging
          // its media type, so an HTML 404 still answers 404.
          const response = await ctx.http.getStream(url, responseOptions(signal));
          if (!isTile(response.status)) {
            await response.stream.cancel().catch(() => {});
            throw new UpstreamTileStatus(response.status);
          }
          const bytes = await new Response(response.stream).arrayBuffer();
          return {
            data: Buffer.from(bytes).toString("base64"),
            contentType: mediaType(response.headers["content-type"], fallbackContentType),
          };
        },
        request.signal,
        (cached) => typeof cached.data === "string" && allowed.includes(cached.contentType),
      );
      succeed(tile.contentType);
      reply.send(Buffer.from(tile.data, "base64"));
      return;
    }

    const response = await ctx.http.getStream(url, responseOptions(request.signal));
    if (!isTile(response.status)) {
      await response.stream.cancel().catch(() => {});
      answerStatus(response.status);
      return;
    }
    succeed(mediaType(response.headers["content-type"], fallbackContentType));
    reply.send(Readable.fromWeb(response.stream as NodeReadableStream<Uint8Array>));
  } catch (error) {
    if (error instanceof UpstreamTileStatus) {
      answerStatus(error.status);
      return;
    }
    if (request.signal?.aborted) return;
    ctx.log.warn(
      `${options.label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendError(reply, 502, `${options.label} unavailable`);
  }
}

/**
 * Route handler that validates `z`, `x` and `y` path parameters against the
 * Web Mercator grid before any upstream request, then proxies the tile with
 * the kind's media types and byte ceiling. Register it with a literal path and
 * `{ rateLimitTier: "tile" }` so the OpenAPI extraction still sees the route.
 * Wrap it in a handler of your own for gates that must answer first.
 */
export function createTileProxyHandler(
  ctx: IntegrationContext,
  options: TileProxyOptions,
): RouteHandler {
  const { url, maxZoom = DEFAULT_MAX_ZOOM, ySuffix, cache, ...shared } = options;
  return async (request, reply) => {
    const { z = "", x = "", y = "" } = request.params;
    const rawY = ySuffix && y.endsWith(ySuffix) ? y.slice(0, -ySuffix.length) : y;
    const tile = parseWebMercatorTileCoordinates(z, x, rawY, maxZoom);
    const upstream = tile ? url(tile, request) : null;
    if (!tile || upstream === null) {
      sendError(reply, 400, "Invalid tile coordinates");
      return;
    }
    await proxyUpstreamImage(ctx, request, reply, upstream, {
      ...shared,
      ...(cache ? { cache: { key: () => cache.key(tile), ttlSeconds: cache.ttlSeconds } } : {}),
    });
  };
}

/**
 * Route handler for a fixed-path upstream image such as a legend, with the
 * same media, byte, status and logging rules as {@link createTileProxyHandler}.
 * `url` returns null to answer 400.
 */
export function createUpstreamImageHandler(
  ctx: IntegrationContext,
  options: UpstreamImageProxyOptions & { url: (request: TileRequest) => string | null },
): RouteHandler {
  const { url, ...shared } = options;
  return async (request, reply) => {
    const upstream = url(request);
    if (upstream === null) {
      sendError(reply, 400, `Invalid ${options.label} request`);
      return;
    }
    await proxyUpstreamImage(ctx, request, reply, upstream, shared);
  };
}
