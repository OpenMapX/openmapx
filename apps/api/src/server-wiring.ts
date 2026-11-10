import { isIP, type Socket } from "node:net";
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
    // A client that hung up (a map cancelling tiles, a search superseded by
    // the next keystroke) aborts the handler, which then throws. Nothing is
    // sent, so it is not a server failure.
    if (reply.raw.destroyed) {
      request.log.info(
        {
          event: "request.aborted",
          requestId: controlledRequestId(request),
          method: controlledMethod(request),
          route: matchedRoutePattern(request),
          durationMs: duration(request),
          errorClass: safeErrorClass(error),
        },
        "Client closed the request",
      );
      starts.delete(request);
      done();
      return;
    }
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : Math.max(500, reply.statusCode);
    const fields = {
      requestId: controlledRequestId(request),
      method: controlledMethod(request),
      route: matchedRoutePattern(request),
      statusCode,
      durationMs: duration(request),
      errorClass: safeErrorClass(error),
    };
    // A refused request (no session, bad input, missing resource) is the
    // client's outcome, not a server fault. Logging it at `info` keeps it out
    // of the persisted error log, which anyone could otherwise fill with one
    // row per anonymous request.
    if (statusCode < 500) {
      request.log.info({ event: "request.rejected", ...fields }, "Request rejected");
    } else {
      request.log.error({ event: "request.error", ...fields }, "Request failed");
    }
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

/**
 * Closes the connection of a request whose body has still not fully arrived
 * `ms` after the request began, so a client that trickles bytes cannot hold a
 * socket and the memory buffered for its body. That covers a request the server
 * has already answered without reading its body, such as a rejected credential:
 * the rest of the body is discarded, but only the deadline ends a sender that
 * never finishes it. Routes under an exempt path prefix are not timed (large
 * streamed uploads, bounded by their own transfer limits).
 *
 * A request with no body, or whose body has arrived, is never cut, however long
 * its response takes: an event stream or a job wait outlasts the deadline.
 *
 * This is deliberately not Fastify's `requestTimeout`: that bounds the whole
 * request and would cut a long, healthy upload or stream.
 */
export function registerBodyReadDeadline(
  server: FastifyInstance,
  options: { ms: number; exemptRoutePrefixes: string[] },
): void {
  // No deadline outlives the server, whatever state its request was left in.
  const armed = new Set<ReturnType<typeof setTimeout>>();
  server.addHook("onClose", (_instance, done) => {
    for (const timer of armed) clearTimeout(timer);
    armed.clear();
    done();
  });

  const exempt = (url: string): boolean => {
    const query = url.indexOf("?");
    const path = query === -1 ? url : url.slice(0, query);
    return options.exemptRoutePrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  };

  server.addHook("onRequest", (request, reply, done) => {
    const raw = request.raw;
    if (exempt(request.url)) {
      done();
      return;
    }
    // Node dispatches the request once the headers are in, so whether a body is
    // still outstanding can only be known when the deadline expires.
    const timer = setTimeout(() => {
      if (raw.complete) return;
      request.log.warn(
        {
          event: "request.body-deadline",
          requestId: controlledRequestId(request),
          method: controlledMethod(request),
          route: matchedRoutePattern(request),
          deadlineMs: options.ms,
        },
        "Closed a request whose body did not arrive in time",
      );
      raw.destroy();
    }, options.ms);
    timer.unref();
    armed.add(timer);
    let watchedSocket: Socket | undefined;
    const stop = () => {
      clearTimeout(timer);
      armed.delete(timer);
      watchedSocket?.off("close", stop);
    };
    // The body finished, or the request was destroyed with its socket.
    raw.once("end", stop);
    raw.once("close", stop);
    // Once a response has gone out, Node stops tracking its request, so the
    // request is no longer destroyed with the socket and emits neither event
    // when the client leaves. A response sent while the body is still arriving
    // (a rejected credential, a 413) therefore does not stop the clock, but the
    // socket closing does. The listener comes off again in `stop`, so a
    // keep-alive socket does not collect one per request.
    reply.raw.once("close", () => {
      if (raw.complete) {
        stop();
        return;
      }
      const socket = raw.socket;
      if (socket.destroyed) {
        stop();
        return;
      }
      watchedSocket = socket;
      socket.once("close", stop);
    });
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
    // A stream can fail after Fastify copied its success headers to the raw
    // response but before the first byte was committed. Clear those headers
    // so the fixed error body is valid JSON and cannot inherit public caching.
    reply.removeHeader("Content-Type");
    reply.removeHeader("Content-Length");
    reply.removeHeader("Cache-Control");
    return reply
      .header("Cache-Control", "no-store")
      .type("application/json")
      .status(statusCode)
      .send({ error: "Internal Server Error" });
  }
  return reply.status(statusCode).send({ error: error.message });
}

export function corsOptions(trustedWebOrigins: readonly string[] = configuredTrustedWebOrigins()) {
  return {
    origin: [...trustedWebOrigins],
    credentials: true,
    // Explicitly cover the API mutation verbs; the CORS plugin defaults to
    // GET/HEAD/POST, which blocks credential saves and other cross-origin edits.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Browser clients need these response headers when the web app and API are
    // on different origins (the default local-development topology).
    exposedHeaders: [
      "X-OpenMapX-Current-Configuration",
      "Content-Length",
      "Content-Disposition",
      "X-Artifact-Sha256",
      "Vary",
      "X-Tile-Source",
      "Accept-Ranges",
      "Content-Range",
      "ETag",
      "Retry-After",
      "X-OpenMapX-Fetched-At",
      "X-OpenMapX-Stale",
      "X-OpenMapX-Truncated",
      "X-OpenMapX-Sources",
    ],
  };
}

/**
 * True when a matched route template is the prefix itself or sits below it.
 * Classifiers read the template Fastify matched, never the raw URL: the router
 * decodes escapes such as `/%61pi/...` before matching, so a raw-URL check can
 * be steered around by spelling the same path differently.
 */
function routeUnder(route: string, prefix: string): boolean {
  return route === prefix || route.startsWith(`${prefix}/`);
}

function matchedRoute(request: FastifyRequest): string | undefined {
  const route = request.routeOptions?.url;
  return typeof route === "string" ? route : undefined;
}

// Tile-ish routes get their own tier because a single viewport change can
// fan out 30-60 requests; sharing a bucket with the rest of the API would
// let map panning starve unrelated traffic (autocomplete, place lookups).
export const TILE_ROUTE_PREFIXES = [
  "/api/maptiler",
  "/api/tiles",
  "/api/traffic",
  "/api/offline/packages/glyphs",
] as const;

export const EXPENSIVE_ROUTE_PREFIXES = [
  "/api/isochrone",
  "/api/elevation",
  "/api/places",
  "/api/image-proxy",
  "/api/winter-sports",
  "/api/offline/packages/prepare",
] as const;

export function isTimelineApiRequest(request: FastifyRequest): boolean {
  const route = matchedRoute(request);
  return route !== undefined && routeUnder(route, "/api/timeline");
}

function isExpensiveTimelineRequest(request: FastifyRequest, route: string): boolean {
  return (
    (request.method === "PUT" && route === "/api/timeline/connection") ||
    (request.method === "POST" && route === "/api/timeline/connection/test") ||
    (request.method === "DELETE" && route === "/api/timeline/connection")
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
    const path = matchedRoute(request);
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
  integrationIngress: Limit;
  status: Limit;
  public: Limit;
  unmatched: Limit;
}

const INTEGRATION_DISPATCHER_ROUTES = new Set(["/api/integrations/:id", "/api/integrations/:id/*"]);
const BODY_CAPABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Global rate limiting for the public surface. Every request is classified by
// the route template Fastify matched, so an encoded spelling of a path lands
// in the same tier as the plain one.
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
//   - no matched route           → small dedicated bucket (scanners, typos)
//   - integration dispatcher     → body admission only; the dispatcher charges
//                                  the matched integration route's own tier
//   - `/api/auth/*`              → strict (credential stuffing, email spam)
//   - exactly `GET /api/status`  → 60/minute (dependency snapshot refresh)
//   - tile / map asset routes    → generous (bursty, cacheable, CDN-friendly)
//   - expensive public routes    → tight (Valhalla, place and image fan-out)
//   - every other matched route  → broad floor, including timeline day reads,
//                                  which add a per-user bucket after sign-in
export function makeRateLimitTierHook(limits: RateLimitTiers) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const route = matchedRoute(request);
    if (isTimelineApiRequest(request)) applyTimelinePrivacyHeaders(reply);
    if (route === "/health") return;

    // Trust only the actual TCP peer here, never XFF.
    const peer = request.socket?.remoteAddress;
    if (peer && LOOPBACK.has(peer)) return;

    if (route === undefined) {
      await limits.unmatched(request, reply);
      return;
    }

    // Fastify parses these methods' bodies before the dispatcher can select
    // the matched route's declared tier. Charge a separate admission bucket
    // first; GET/HEAD keep their deliberate late tier.
    if (INTEGRATION_DISPATCHER_ROUTES.has(route)) {
      if (BODY_CAPABLE_METHODS.has(request.method)) {
        await limits.integrationIngress(request, reply);
      }
      return;
    }

    if (routeUnder(route, "/api/auth")) {
      await limits.auth(request, reply);
      return;
    }
    if (request.method === "GET" && route === "/api/status") {
      await limits.status(request, reply);
      return;
    }
    if (TILE_ROUTE_PREFIXES.some((prefix) => routeUnder(route, prefix))) {
      await limits.tile(request, reply);
      return;
    }
    if (
      isExpensiveTimelineRequest(request, route) ||
      EXPENSIVE_ROUTE_PREFIXES.some((prefix) => routeUnder(route, prefix))
    ) {
      await limits.expensive(request, reply);
      return;
    }
    await limits.public(request, reply);
  };
}
