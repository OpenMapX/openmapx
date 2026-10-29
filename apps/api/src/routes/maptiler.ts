import { readBoundedJsonResponse, USER_AGENT } from "@openmapx/core";
import {
  createBoundedBinaryProxyStream,
  MAX_RASTER_TILE_BYTES,
  MAX_VECTOR_TILE_BYTES,
  VECTOR_TILE_MEDIA_TYPES,
} from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { loadMapSettings } from "../utils/map-settings.js";
import { bindRequestAbort, withDeadline } from "../utils/request-abort.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { safeErrorClass, summarizeExternalUrl } from "../utils/safe-log-fields.js";
import { parseWebMercatorTileCoordinates } from "../utils/tile-coordinates.js";
import {
  discardUpstreamResponse,
  normalizeUpstreamResponseStream,
} from "../utils/upstream-response.js";

const MAPTILER_ORIGIN = "https://api.maptiler.com";
const MAPTILER_MAX_ZOOM = 22;
const MAPTILER_TIMEOUT_MS = 15_000;
const JSON_MEDIA_TYPES = ["application/json"] as const;

const STYLE_RE = /^maps\/[a-z0-9_-]+\/style\.json$/i;
const SPRITE_RE = /^maps\/[a-z0-9_-]+\/sprite(?:(?:@2x)?\.(?:json|png))?$/i;
const TILEJSON_RE = /^tiles\/[a-z0-9_-]+\/tiles\.json$/i;
const TILE_RE =
  /^tiles\/[a-z0-9_-]+\/(?<z>\d{1,2})\/(?<x>\d+)\/(?<y>\d+)\.(?<format>pbf|mvt|png|jpe?g|webp)$/i;
const FONT_RE = /^fonts\/[^/]+\/\d+-\d+\.pbf$/i;
const TILE_TEMPLATE_RE =
  /^tiles\/[a-z0-9_-]+\/(?:\{z\}|\d{1,2})\/(?:\{x\}|\d+)\/(?:\{y\}|\d+)\.(?:pbf|mvt|png|jpe?g|webp)$/i;
const FONT_TEMPLATE_RE = /^fonts\/(?:\{fontstack\}|[^/]+)\/(?:\{range\}|\d+-\d+)\.pbf$/i;

type JsonRecord = Record<string, unknown>;

interface MaptilerTileMatch {
  z: string;
  x: string;
  y: string;
  format: string;
}

function maptilerKey(): string {
  return envString("MAPTILER_KEY", envString("NEXT_PUBLIC_MAPTILER_KEY", "")).trim();
}

function isAllowedMaptilerPath(path: string): boolean {
  return (
    STYLE_RE.test(path) ||
    SPRITE_RE.test(path) ||
    TILEJSON_RE.test(path) ||
    TILE_RE.test(path) ||
    FONT_RE.test(path)
  );
}

function isRewritableMaptilerPath(path: string): boolean {
  return isAllowedMaptilerPath(path) || TILE_TEMPLATE_RE.test(path) || FONT_TEMPLATE_RE.test(path);
}

function maptilerTileMatch(path: string): MaptilerTileMatch | null {
  const groups = TILE_RE.exec(path)?.groups;
  if (!groups?.z || !groups.x || !groups.y || !groups.format) return null;
  return { z: groups.z, x: groups.x, y: groups.y, format: groups.format.toLowerCase() };
}

function binaryResponseOptions(path: string): {
  maxBytes: number;
  allowedContentTypes: readonly string[];
  label: string;
} {
  const tile = maptilerTileMatch(path);
  const extension = tile?.format ?? path.split(".").at(-1)?.toLowerCase();
  if (extension === "pbf" || extension === "mvt" || FONT_RE.test(path)) {
    return {
      maxBytes: MAX_VECTOR_TILE_BYTES,
      allowedContentTypes: VECTOR_TILE_MEDIA_TYPES,
      label: "MapTiler vector asset",
    };
  }
  if (extension === "json") {
    return {
      maxBytes: MAX_VECTOR_TILE_BYTES,
      allowedContentTypes: JSON_MEDIA_TYPES,
      label: "MapTiler sprite JSON",
    };
  }
  if (extension === "jpg" || extension === "jpeg") {
    return {
      maxBytes: MAX_RASTER_TILE_BYTES,
      allowedContentTypes: ["image/jpeg"],
      label: "MapTiler raster asset",
    };
  }
  if (extension === "webp") {
    return {
      maxBytes: MAX_RASTER_TILE_BYTES,
      allowedContentTypes: ["image/webp"],
      label: "MapTiler raster asset",
    };
  }
  if (extension === "png") {
    return {
      maxBytes: MAX_RASTER_TILE_BYTES,
      allowedContentTypes: ["image/png"],
      label: "MapTiler raster asset",
    };
  }
  return {
    maxBytes: MAX_RASTER_TILE_BYTES,
    allowedContentTypes: ["application/json", "image/png"],
    label: "MapTiler sprite asset",
  };
}

function requireMaptilerJsonContentType(response: Response, label: string): void {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") return;
  discardUpstreamResponse(response);
  throw new Error(`${label} did not declare application/json`);
}

/**
 * Resolve the public base URL of this API used to rewrite upstream MapTiler
 * URLs into self-hosted proxy URLs.
 *
 * SECURITY: we read this from configuration (`PUBLIC_BASE_URL` or `DOMAIN`),
 * never from request headers. `X-Forwarded-Host` / `X-Forwarded-Proto` are
 * client-controllable through a reverse proxy unless the proxy is configured
 * to strip them — and the only way to know that is to not depend on them.
 * If a downstream CDN ever caches a style.json keyed by upstream host, an
 * attacker setting `X-Forwarded-Host: evil.com` could poison the cached
 * response and redirect tile/sprite/font fetches to attacker-controlled
 * origins for every subsequent user.
 *
 * For local development, falls back to the request's Host header — that path
 * is only reachable when `PUBLIC_BASE_URL` and `DOMAIN` are both unset.
 */
function publicBaseUrl(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const domain = process.env.DOMAIN?.trim();
  if (domain && domain !== "localhost") return `https://${domain}`;

  // Dev fallback: use the request's host header. Acceptable because a dev
  // checkout is not deployed behind a CDN and there is no cache to poison.
  const host = req.headers.host ?? "localhost:3001";
  const proto = req.protocol ?? "http";
  return `${proto}://${host}`;
}

function proxyBase(req: FastifyRequest): string {
  return `${publicBaseUrl(req)}/api/maptiler`;
}

function encodePath(path: string, preservePlaceholders = false): string {
  return path
    .split("/")
    .map((segment) => {
      const encoded = encodeURIComponent(segment);
      return preservePlaceholders
        ? encoded.replace(/%7B(fontstack|range|z|x|y)%7D/gi, "{$1}")
        : encoded;
    })
    .join("/");
}

function maptilerProxyUrl(path: string, base: string, preservePlaceholders = false): string {
  return `${base}/${encodePath(path, preservePlaceholders)}`;
}

function rewriteMaptilerUrl(value: string, base: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== MAPTILER_ORIGIN) return value;
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!isRewritableMaptilerPath(path)) return value;
    return maptilerProxyUrl(path, base, true);
  } catch {
    return value;
  }
}

function rewriteTileJson(tileJson: JsonRecord, base: string): JsonRecord {
  return {
    ...tileJson,
    tiles: Array.isArray(tileJson.tiles)
      ? tileJson.tiles.map((tile) =>
          typeof tile === "string" ? rewriteMaptilerUrl(tile, base) : tile,
        )
      : tileJson.tiles,
  };
}

function rewriteStyle(style: JsonRecord, base: string): JsonRecord {
  const rewritten: JsonRecord = { ...style };

  if (typeof rewritten.glyphs === "string") {
    rewritten.glyphs = rewriteMaptilerUrl(rewritten.glyphs, base);
  }
  if (typeof rewritten.sprite === "string") {
    rewritten.sprite = rewriteMaptilerUrl(rewritten.sprite, base);
  }

  if (rewritten.sources && typeof rewritten.sources === "object") {
    const sources: Record<string, unknown> = {};
    for (const [id, source] of Object.entries(rewritten.sources as Record<string, JsonRecord>)) {
      if (!source || typeof source !== "object") {
        sources[id] = source;
        continue;
      }
      sources[id] = {
        ...source,
        url: typeof source.url === "string" ? rewriteMaptilerUrl(source.url, base) : source.url,
        tiles: Array.isArray(source.tiles)
          ? source.tiles.map((tile) =>
              typeof tile === "string" ? rewriteMaptilerUrl(tile, base) : tile,
            )
          : source.tiles,
      };
    }
    rewritten.sources = sources;
  }

  return rewritten;
}

function getRequestedMaptilerPath(req: FastifyRequest): string | null {
  const pathname = new URL(req.url, "http://openmapx.local").pathname;
  const marker = "/maptiler/";
  const idx = pathname.indexOf(marker);
  if (idx === -1) return null;
  try {
    return decodeURIComponent(pathname.slice(idx + marker.length));
  } catch {
    return null;
  }
}

export const maptilerRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get("/maptiler/*", async (req, reply) => {
    const path = getRequestedMaptilerPath(req);
    if (!path || !isAllowedMaptilerPath(path)) {
      return reply.status(400).send({ message: "Unsupported MapTiler asset path" });
    }
    const tile = maptilerTileMatch(path);
    if (tile && !parseWebMercatorTileCoordinates(tile.z, tile.x, tile.y, MAPTILER_MAX_ZOOM)) {
      return reply.status(400).send({ message: "Invalid tile coordinates" });
    }
    reply.header("Cache-Control", "no-store");

    const key = maptilerKey() || (await loadMapSettings()).maptilerApiKey;
    if (!key) {
      return reply.status(503).send({ message: "MapTiler API key is not configured" });
    }

    // MapTiler serves high-density sprites at a literal @2x path and returns
    // 404 for the percent-encoded %402x form. The allowlist above restricts
    // this exception to sprite JSON/PNG filenames.
    const upstreamPath = encodePath(path).replace(/%40(?=2x\.(?:json|png)$)/i, "@");
    const upstreamUrl = new URL(`${MAPTILER_ORIGIN}/${upstreamPath}`);
    upstreamUrl.searchParams.set("key", key);

    const requestAbort = bindRequestAbort(req, reply);
    const signal = withDeadline(requestAbort.signal, MAPTILER_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "error",
        signal,
      });
    } catch (error) {
      req.log.warn(
        { upstream: summarizeExternalUrl(upstreamUrl.href), errorClass: safeErrorClass(error) },
        "MapTiler proxy fetch failed",
      );
      return reply.status(502).send({ message: "MapTiler provider unavailable" });
    }

    if (!upstream.ok) {
      discardUpstreamResponse(upstream);
      return reply.status(upstream.status).send({ message: "MapTiler upstream error" });
    }

    if (upstream.status === 204) {
      return reply.status(204).send();
    }

    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");

    try {
      const base = proxyBase(req);
      if (STYLE_RE.test(path)) {
        requireMaptilerJsonContentType(upstream, "MapTiler style JSON");
        const style = await readBoundedJsonResponse<JsonRecord>(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          label: "MapTiler style JSON",
          signal,
        });
        return reply.type("application/json").send(rewriteStyle(style, base));
      }
      if (TILEJSON_RE.test(path)) {
        requireMaptilerJsonContentType(upstream, "MapTiler TileJSON");
        const tileJson = await readBoundedJsonResponse<JsonRecord>(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          label: "MapTiler TileJSON",
          signal,
        });
        return reply.type("application/json").send(rewriteTileJson(tileJson, base));
      }

      const proxy = createBoundedBinaryProxyStream(upstream, binaryResponseOptions(path));
      reply.type(proxy.contentType);
      return reply.send(
        normalizeUpstreamResponseStream(
          proxy.body,
          "MapTiler provider returned an invalid response",
        ),
      );
    } catch (error) {
      req.log.warn(
        { upstream: summarizeExternalUrl(upstreamUrl.href), errorClass: safeErrorClass(error) },
        "MapTiler proxy response rejected",
      );
      return reply
        .header("Cache-Control", "no-store")
        .status(502)
        .send({ message: "MapTiler provider returned an invalid response" });
    }
  });
};
