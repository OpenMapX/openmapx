import { readBoundedJsonResponse, USER_AGENT } from "@openmapx/core";
import {
  createBoundedBinaryProxyStream,
  MAX_RASTER_TILE_BYTES,
  MAX_VECTOR_TILE_BYTES,
  VECTOR_TILE_MEDIA_TYPES,
} from "@openmapx/core/server";
import type { ProviderDailyBudget } from "@openmapx/integration-framework/provider-daily-budget";
import { parseWebMercatorTileCoordinates } from "@openmapx/integration-framework/tile-proxy";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  maptilerDailyBudget,
  sendProviderBudgetRefusal,
} from "../services/provider-daily-budget.js";
import { loadMapSettings } from "../utils/map-settings.js";
import { bindRequestAbort, withDeadline } from "../utils/request-abort.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { safeErrorClass, summarizeExternalUrl } from "../utils/safe-log-fields.js";
import {
  discardUpstreamResponse,
  normalizeUpstreamResponseStream,
} from "../utils/upstream-response.js";

const MAPTILER_ORIGIN = "https://api.maptiler.com";
const MAPTILER_MAX_ZOOM = 22;
const MAPTILER_TIMEOUT_MS = 15_000;

const STYLE_RE = /^maps\/[a-z0-9_-]+\/style\.json$/i;
const SPRITE_RE = /^maps\/[a-z0-9_-]+\/sprite(?:(?:@2x)?\.(?:json|png))?$/i;
const SPRITE_JSON_RE = /^maps\/[a-z0-9_-]+\/sprite(?:@2x)?\.json$/i;
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
  } else if (Array.isArray(rewritten.sprite)) {
    // The style spec also allows a list of `{ id, url }` sprite sheets.
    rewritten.sprite = rewritten.sprite.map((entry) =>
      entry && typeof entry === "object" && typeof (entry as JsonRecord).url === "string"
        ? { ...entry, url: rewriteMaptilerUrl((entry as JsonRecord).url as string, base) }
        : entry,
    );
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

const ABSOLUTE_URL_RE = /^(?:https?:)?\/\//i;

function isMaptilerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "maptiler.com" || host.endsWith(".maptiler.com");
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Remove the `key` query parameter from a URL string that either points at a
 * MapTiler host or carries the configured key. The query is edited as text
 * because `URL` and `URLSearchParams` re-encode `{z}`-style template
 * placeholders, which would break tile and glyph templates.
 */
function stripKeyParam(value: string, key: string): string {
  if (!ABSOLUTE_URL_RE.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return value;
  }
  const onMaptiler = isMaptilerHost(parsed.hostname);
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : value.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) return value;

  const parts = beforeHash.slice(queryIndex + 1).split("&");
  const kept = parts.filter((part) => {
    const separator = part.indexOf("=");
    const name = decodeQueryComponent(separator === -1 ? part : part.slice(0, separator));
    if (name !== "key") return true;
    if (onMaptiler) return false;
    return decodeQueryComponent(separator === -1 ? "" : part.slice(separator + 1)) !== key;
  });
  if (kept.length === parts.length) return value;
  const query = kept.join("&");
  return `${beforeHash.slice(0, queryIndex)}${query ? `?${query}` : ""}${hash}`;
}

/**
 * Walk a whole JSON document and strip the key from every URL string, so
 * fields the targeted rewrite does not know about cannot pass it through.
 */
function stripMaptilerKey(value: unknown, key: string, counter: { stripped: number }): unknown {
  if (typeof value === "string") {
    const stripped = stripKeyParam(value, key);
    if (stripped !== value) counter.stripped += 1;
    return stripped;
  }
  if (Array.isArray(value)) return value.map((item) => stripMaptilerKey(item, key, counter));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, stripMaptilerKey(item, key, counter)]),
    );
  }
  return value;
}

class MaptilerKeyLeakError extends Error {
  override name = "MaptilerKeyLeakError";
}

/**
 * Serialize a response document and refuse it if the key is still present
 * anywhere, for example inside HTML or a string that is not a URL.
 */
function serializeKeySafe(value: unknown, key: string): string {
  const serialized = JSON.stringify(value);
  const forms = [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)];
  if (forms.some((form) => serialized.includes(form))) {
    throw new MaptilerKeyLeakError("MapTiler response contained the API key");
  }
  return serialized;
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

export const maptilerRoute: FastifyPluginAsync<{ budget?: ProviderDailyBudget | null }> = async (
  fastify,
  options,
) => {
  declareRouteAuth(fastify, "public");
  // An operator can cap what all clients together spend on the key each day,
  // on top of the per-client tile limit. Off unless configured: the proxy can
  // carry the whole basemap.
  const budget = options.budget === undefined ? maptilerDailyBudget() : options.budget;

  fastify.get("/maptiler/*", async (req, reply) => {
    const path = getRequestedMaptilerPath(req);
    if (!path || !isAllowedMaptilerPath(path)) {
      return reply.status(400).send({ error: "Unsupported MapTiler asset path" });
    }
    const tile = maptilerTileMatch(path);
    if (tile && !parseWebMercatorTileCoordinates(tile.z, tile.x, tile.y, MAPTILER_MAX_ZOOM)) {
      return reply.status(400).send({ error: "Invalid tile coordinates" });
    }
    reply.header("Cache-Control", "no-store");

    const key = (await loadMapSettings()).maptilerApiKey;
    if (!key) {
      return reply.status(503).send({ error: "MapTiler API key is not configured" });
    }

    // MapTiler serves high-density sprites at a literal @2x path and returns
    // 404 for the percent-encoded %402x form. The allowlist above restricts
    // this exception to sprite JSON/PNG filenames.
    const upstreamPath = encodePath(path).replace(/%40(?=2x\.(?:json|png)$)/i, "@");
    const upstreamUrl = new URL(`${MAPTILER_ORIGIN}/${upstreamPath}`);
    upstreamUrl.searchParams.set("key", key);

    const requestAbort = bindRequestAbort(req, reply);
    const admission = budget ? await budget.admit(requestAbort.signal) : { allowed: true as const };
    if (!admission.allowed) {
      return sendProviderBudgetRefusal(reply, admission, "MapTiler", req.log);
    }
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
      return reply.status(502).send({ error: "MapTiler provider unavailable" });
    }

    if (!upstream.ok) {
      discardUpstreamResponse(upstream);
      return reply.status(upstream.status).send({ error: "MapTiler upstream error" });
    }

    if (upstream.status === 204) {
      return reply.status(204).send();
    }

    reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");

    // Every JSON body is served through here: strip the key from all URL
    // strings, then refuse the document if the key survives anywhere.
    const sendKeySafeJson = (document: unknown) => {
      const counter = { stripped: 0 };
      const body = serializeKeySafe(stripMaptilerKey(document, key, counter), key);
      if (counter.stripped > 0) {
        req.log.warn(
          { upstream: summarizeExternalUrl(upstreamUrl.href), strippedCount: counter.stripped },
          "MapTiler key stripped from URLs the proxy cannot rewrite",
        );
      }
      return reply.type("application/json").send(body);
    };

    try {
      const base = proxyBase(req);
      if (STYLE_RE.test(path)) {
        requireMaptilerJsonContentType(upstream, "MapTiler style JSON");
        const style = await readBoundedJsonResponse<JsonRecord>(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          label: "MapTiler style JSON",
          signal,
        });
        return sendKeySafeJson(rewriteStyle(style, base));
      }
      if (TILEJSON_RE.test(path)) {
        requireMaptilerJsonContentType(upstream, "MapTiler TileJSON");
        const tileJson = await readBoundedJsonResponse<JsonRecord>(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          label: "MapTiler TileJSON",
          signal,
        });
        return sendKeySafeJson(rewriteTileJson(tileJson, base));
      }
      if (SPRITE_JSON_RE.test(path)) {
        requireMaptilerJsonContentType(upstream, "MapTiler sprite JSON");
        const sprite = await readBoundedJsonResponse<unknown>(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          label: "MapTiler sprite JSON",
          signal,
        });
        return sendKeySafeJson(sprite);
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
        .send({ error: "MapTiler provider returned an invalid response" });
    }
  });
};
