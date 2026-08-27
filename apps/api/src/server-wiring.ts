import { isIP } from "node:net";
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { LogController } from "fastify";
import { configuredTrustedWebOrigins } from "./utils/csrf.js";
import type { RateLimiter } from "./utils/rate-limit.js";
import { safeErrorClass } from "./utils/safe-log-fields.js";

export function controlledRequestLoggingOptions(loggerInstance: FastifyBaseLogger): {
  loggerInstance: FastifyBaseLogger;
  logController: LogController;
} {
  return {
    loggerInstance,
    logController: new LogController({ disableRequestLogging: true }),
  };
}

function controlledRequestId(request: FastifyRequest): string {
  const requestId = String(request.id);
  return /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? requestId : "unknown";
}

function controlledMethod(request: FastifyRequest): string {
  return /^[A-Z]{1,16}$/.test(request.method) ? request.method : "OTHER";
}

function matchedRoutePattern(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (
    typeof route !== "string" ||
    !route.startsWith("/") ||
    route.length > 512 ||
    /[?#\p{Cc}]/u.test(route)
  ) {
    return "unmatched";
  }
  return route;
}

export function registerControlledRequestLogging(
  server: FastifyInstance,
  options: { now?: () => number } = {},
): void {
  const now = options.now ?? (() => performance.now());
  const starts = new WeakMap<FastifyRequest, number>();
  const duration = (request: FastifyRequest): number => {
    const startedAt = starts.get(request) ?? now();
    return Math.max(0, Math.round((now() - startedAt) * 1_000) / 1_000);
  };

  server.addHook("onRequest", (request, _reply, done) => {
    starts.set(request, now());
    request.log.info(
      {
        event: "request.start",
        requestId: controlledRequestId(request),
        method: controlledMethod(request),
      },
      "Request started",
    );
    done();
  });

  server.addHook("onError", (request, reply, error, done) => {
    request.log.error(
      {
        event: "request.error",
        requestId: controlledRequestId(request),
        method: controlledMethod(request),
        route: matchedRoutePattern(request),
        statusCode:
          typeof error.statusCode === "number" && error.statusCode >= 400
            ? error.statusCode
            : Math.max(500, reply.statusCode),
        durationMs: duration(request),
        errorClass: safeErrorClass(error),
      },
      "Request failed",
    );
    done();
  });

  server.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        event: "request.complete",
        requestId: controlledRequestId(request),
        method: controlledMethod(request),
        route: matchedRoutePattern(request),
        statusCode: reply.statusCode,
        durationMs: duration(request),
      },
      "Request completed",
    );
    starts.delete(request);
    done();
  });
}

const TRUST_PROXY_ALIASES = new Set(["loopback", "linklocal", "uniquelocal"]);

function validateProxyRange(value: string): void {
  if (TRUST_PROXY_ALIASES.has(value)) return;
  const parts = value.split("/");
  const address = parts[0] ?? "";
  const family = isIP(address);
  if (family === 0 || parts.length > 2) {
    throw new Error(`TRUST_PROXY_RANGES contains an invalid IP or CIDR: "${value}"`);
  }
  if (parts.length === 1) return;
  const prefixText = parts[1] ?? "";
  const prefix = Number(prefixText);
  const maximum = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix > maximum) {
    throw new Error(`TRUST_PROXY_RANGES contains an invalid CIDR prefix: "${value}"`);
  }
  if (prefix === 0) {
    throw new Error(`TRUST_PROXY_RANGES must not trust every address: "${value}"`);
  }
}

// Forwarding headers are ignored unless the immediate socket peer belongs to
// an explicitly trusted IP/CIDR range. The default container deployment sets
// `uniquelocal`, which covers Docker's private IPv4 and ULA IPv6 networks; a
// directly run development server leaves the variable unset and trusts none.
// Address-based trust is essential: hop counts cannot distinguish the real
// reverse proxy from a client that reaches the origin directly.
export function trustProxyConfig(): false | string[] {
  const raw = process.env.TRUST_PROXY_RANGES?.trim();
  if (raw === undefined || raw === "") return false;
  const ranges = raw.split(",").map((value) => value.trim());
  if (ranges.some((value) => value.length === 0)) {
    throw new Error("TRUST_PROXY_RANGES must be a comma-separated list without empty entries");
  }
  for (const range of ranges) validateProxyRange(range);
  return ranges;
}

// Uniform error body. Throwing handlers/guards (requireAuth/requireAdmin throw
// httpError, route validation throws with statusCode) would otherwise serialize
// via Fastify's default to `{ statusCode, error: "<HTTP phrase>", message }` —
// but every client reads `body.error` for the human-readable text, so a thrown
// 401 would show "Unauthorized" instead of "Authentication required". Restore
// the API's `{ error: <message> }` shape for 4xx (matching routes that send it
// directly), and never leak an internal 5xx message.
export function uniformErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    return reply.status(statusCode).send({ error: "Internal Server Error" });
  }
  return reply.status(statusCode).send({ error: error.message });
}

export function corsOptions(trustedWebOrigins: readonly string[] = configuredTrustedWebOrigins()) {
  return {
    origin: [...trustedWebOrigins],
    credentials: true,
    // Browser clients need these response headers when the web app and API are
    // on different origins (the default local-development topology).
    exposedHeaders: [
      "X-Tile-Source",
      "Accept-Ranges",
      "Content-Range",
      "ETag",
      "X-OpenMapX-Fetched-At",
      "X-OpenMapX-Stale",
    ],
  };
}

// Tile-ish routes get their own tier because a single viewport change can
// fan out 30-60 requests; sharing a bucket with the rest of the API would
// let map panning starve unrelated traffic (autocomplete, place lookups).
export const TILE_PUBLIC_PATTERNS = [
  /^\/api\/maptiler\//,
  /^\/api\/tiles\//,
  /^\/api\/traffic\//,
  /^\/api\/integrations\/street-level-imagery-[a-z0-9-]+\/tiles\//,
  /^\/api\/offline\/packages\/(glyphs\/|omp2-[0-9a-f]{64}\/archive(?:$|\?))/,
];

export const EXPENSIVE_PUBLIC_PATTERNS = [
  /^\/api\/isochrone(\/|$|\?)/,
  /^\/api\/elevation(\/|$|\?)/,
  /^\/api\/motis(\/|$)/,
  /^\/api\/places(\/|$|\?)/,
  /^\/api\/image-proxy(\/|$|\?)/,
  /^\/api\/winter-sports(\/|$)/,
  /^\/api\/integrations\/search-nlp(\/|$|\?)/,
  /^\/api\/integrations\/food-delivery\/(resolve|[^/]+\/(open|url))(\/|$|\?)/,
  /^\/api\/integrations\/restaurants\/menu(\/|$|\?)/,
  /^\/api\/offline\/packages\/prepare(\/|$|\?)/,
];

export function isTimelineApiRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  return path?.startsWith("/api/timeline/") ?? false;
}

export function isTimelineDayRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  return request.method === "GET" && /^\/api\/timeline\/day\/[^/]+$/.test(path ?? "");
}

function isExpensiveTimelineRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  return (
    (request.method === "PUT" && path === "/api/timeline/connection") ||
    (request.method === "POST" && path === "/api/timeline/connection/test") ||
    (request.method === "DELETE" && path === "/api/timeline/connection")
  );
}

function addVaryHeader(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("Vary");
  const values = (Array.isArray(existing) ? existing : [existing])
    .flatMap((entry) => String(entry ?? "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  reply.header("Vary", values.join(", "));
}

export function applyMobileAuthPrivacyHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Referrer-Policy", "no-referrer");
}

export function applyPublicStatusCacheHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
}

export function applyAdminStatusPrivacyHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  addVaryHeader(reply, "Cookie");
}

/**
 * Installs endpoint-specific response policy before the global rate limiter.
 * Exact matching prevents privacy headers from becoming an accidental route
 * classifier for status-like or mobile-auth-like paths.
 */
export function makeSecurityResponseHeaderHook() {
  return (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = request.url.split("?", 1)[0];
    if (
      request.method === "POST" &&
      (path === "/api/mobile-auth/issue" || path === "/api/mobile-auth/exchange")
    ) {
      applyMobileAuthPrivacyHeaders(reply);
    } else if (request.method === "GET" && path === "/api/status") {
      applyPublicStatusCacheHeaders(reply);
    } else if (request.method === "GET" && path === "/api/admin/status") {
      applyAdminStatusPrivacyHeaders(reply);
    }
    return Promise.resolve();
  };
}

export function applyTimelinePrivacyHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  addVaryHeader(reply, "Cookie");
}

export function sendTimelineRateLimitResponse(reply: FastifyReply, retryAfterSeconds: number) {
  const boundedRetryAfter = Math.min(
    86_400,
    Math.max(0, Number.isFinite(retryAfterSeconds) ? Math.ceil(retryAfterSeconds) : 86_400),
  );
  applyTimelinePrivacyHeaders(reply);
  return reply.header("Retry-After", String(boundedRetryAfter)).status(429).send({
    error: "Timeline source is rate limited",
    code: "TIMELINE_RATE_LIMITED",
    retryAfterSeconds: boundedRetryAfter,
  });
}

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

type Limit = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function makeTimelineAwareRateLimit(limiter: Pick<RateLimiter, "preHandler">): Limit {
  const defaultLimit = limiter.preHandler();
  const timelineLimit = limiter.preHandler({
    onLimit: (_request, reply, retryAfterSeconds) =>
      sendTimelineRateLimitResponse(reply, retryAfterSeconds),
  });
  return async (request, reply) =>
    isTimelineApiRequest(request) ? timelineLimit(request, reply) : defaultLimit(request, reply);
}

export function makeStatusAwareRateLimit(limiter: Pick<RateLimiter, "preHandler">): Limit {
  return limiter.preHandler({
    onLimit: (_request, reply, retryAfterSeconds) => {
      reply.header("Cache-Control", "private, no-store");
      reply.header("Pragma", "no-cache");
      return reply
        .header("Retry-After", String(retryAfterSeconds))
        .status(429)
        .send({ error: "Too many requests", retryAfter: retryAfterSeconds });
    },
  });
}

export interface RateLimitTiers {
  auth: Limit;
  tile: Limit;
  expensive: Limit;
  status: Limit;
  public: Limit;
}

// Global rate limiting for the public surface.
//
// Skips:
//   - `/health` — used by Docker/Traefik healthchecks at high frequency.
//   - Loopback socket peers — the CLI and admin sweeps run locally; admin
//     endpoints layer their own per-action limiters on top (see `admin.ts`,
//     `admin-store.ts`, `admin-services.ts`, `admin-settings.ts`). We read
//     `socket.remoteAddress` here, not `request.ip`, so a public client
//     cannot forge XFF to bypass the limit (see `require-admin.ts`).
//
// Tiers, applied in order:
//   - `/api/auth/*`              → strict (credential stuffing, email spam)
//   - tile / map asset routes    → generous (bursty, cacheable, CDN-friendly)
//   - expensive public routes    → tight (Valhalla, MOTIS, geocoding fan-out)
//   - exactly `GET /api/status`  → 60/minute (dependency snapshot refresh)
//   - everything else            → broad floor
export function makeRateLimitTierHook(limits: RateLimitTiers) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;
    if (isTimelineApiRequest(request)) applyTimelinePrivacyHeaders(reply);
    if (url === "/health" || url.startsWith("/health?")) return;
    // Day reads are limited after the timeline plugin authenticates the user,
    // using a separate per-user expensive bucket. Do not stack the pre-auth IP
    // limiter or broad public floor on this privacy-sensitive route.
    if (isTimelineDayRequest(request)) return;

    // Trust only the actual TCP peer here, never XFF.
    const peer = request.socket?.remoteAddress;
    if (peer && LOOPBACK.has(peer)) return;

    if (url.startsWith("/api/auth/")) {
      await limits.auth(request, reply);
      return;
    }
    const path = url.split("?", 1)[0];
    if (request.method === "GET" && path === "/api/status") {
      await limits.status(request, reply);
      return;
    }
    if (TILE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
      await limits.tile(request, reply);
      return;
    }
    if (isExpensiveTimelineRequest(request) || EXPENSIVE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
      await limits.expensive(request, reply);
      return;
    }
    if (url.startsWith("/api/")) {
      await limits.public(request, reply);
    }
  };
}
