import { USER_AGENT } from "@openmapx/core";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { envString } from "../utils/env.js";
import { declareRouteAuth } from "../utils/route-auth.js";

const MAPTILER_ORIGIN = "https://api.maptiler.com";

const STYLE_RE = /^maps\/[a-z0-9_-]+\/style\.json$/i;
const SPRITE_RE = /^maps\/[a-z0-9_-]+\/sprite(?:(?:@2x)?\.(?:json|png))?$/i;
const TILEJSON_RE = /^tiles\/[a-z0-9_-]+\/tiles\.json$/i;
const TILE_RE = /^tiles\/[a-z0-9_-]+\/\d{1,2}\/\d+\/\d+\.(?:pbf|mvt|png|jpe?g|webp)$/i;
const FONT_RE = /^fonts\/[^/]+\/\d+-\d+\.pbf$/i;
const TILE_TEMPLATE_RE =
  /^tiles\/[a-z0-9_-]+\/(?:\{z\}|\d{1,2})\/(?:\{x\}|\d+)\/(?:\{y\}|\d+)\.(?:pbf|mvt|png|jpe?g|webp)$/i;
const FONT_TEMPLATE_RE = /^fonts\/(?:\{fontstack\}|[^/]+)\/(?:\{range\}|\d+-\d+)\.pbf$/i;

type JsonRecord = Record<string, unknown>;

function maptilerKey(): string {
  return envString("MAPTILER_KEY", envString("NEXT_PUBLIC_MAPTILER_KEY", ""));
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
    const key = maptilerKey();
    if (!key) {
      return reply.status(503).send({ message: "MapTiler API key is not configured" });
    }

    const path = getRequestedMaptilerPath(req);
    if (!path || !isAllowedMaptilerPath(path)) {
      return reply.status(400).send({ message: "Unsupported MapTiler asset path" });
    }

    const upstreamUrl = new URL(`${MAPTILER_ORIGIN}/${encodePath(path)}`);
    upstreamUrl.searchParams.set("key", key);

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      req.log.warn({ err: error, path }, "MapTiler proxy fetch failed");
      return reply.status(502).send({ message: "MapTiler provider unavailable" });
    }

    if (!upstream.ok) {
      return reply.status(upstream.status).send({ message: "MapTiler upstream error" });
    }

    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");

    const base = proxyBase(req);
    if (STYLE_RE.test(path)) {
      const style = (await upstream.json()) as JsonRecord;
      return reply.type("application/json").send(rewriteStyle(style, base));
    }
    if (TILEJSON_RE.test(path)) {
      const tileJson = (await upstream.json()) as JsonRecord;
      return reply.type("application/json").send(rewriteTileJson(tileJson, base));
    }

    const contentType = upstream.headers.get("content-type");
    if (contentType) reply.type(contentType);
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
};
