import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterOptions {
  /** Maximum number of tokens (requests) in the bucket. */
  max: number;
  /** Time window in milliseconds to fully refill the bucket. */
  windowMs: number;
  /** Optional function to derive a key from the request (default: composite
   *  of `request.ip` + socket peer — see `defaultKeyFn`). */
  keyFn?: (request: FastifyRequest) => string;
  /**
   * Optional 429 body. Routes with their own closed error taxonomy pass one so
   * a throttled response is the same shape as every other typed failure.
   */
  errorBody?: (retryAfterSeconds: number) => unknown;
}

export interface RateLimitHookOptions {
  onLimit?: (request: FastifyRequest, reply: FastifyReply, retryAfterSeconds: number) => unknown;
}

/**
 * Default rate-limit key. Combines:
 *  - `request.ip` — the trusted-proxy-derived client IP. Behind a correctly
 *    configured proxy this is the real client; under direct exposure or a
 *    misconfigured proxy it can be attacker-controlled via X-Forwarded-For.
 *  - `request.socket.remoteAddress` — the actual TCP peer, which the
 *    attacker can never spoof (it's whatever socket the connection landed on).
 *
 * The composite key keeps per-client granularity behind a real proxy (where
 * the socket peer is the proxy IP and `req.ip` varies per client) AND
 * prevents XFF rotation from cycling fresh buckets when no proxy is in
 * front (where the socket peer is the attacker and stays constant across
 * forged XFF values). Behind a NAT'd shared proxy two distinct clients
 * still get separate keys because their `request.ip` differs.
 */
function defaultKeyFn(req: FastifyRequest): string {
  const peer = req.socket?.remoteAddress ?? "unknown";
  return `${req.ip}|${peer}`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly keyFn: (request: FastifyRequest) => string;
  private readonly errorBody: (retryAfterSeconds: number) => unknown;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RateLimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.keyFn = options.keyFn ?? defaultKeyFn;
    this.errorBody =
      options.errorBody ?? ((retryAfter: number) => ({ error: "Too many requests", retryAfter }));

    // Periodically clean stale buckets every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * Returns a Fastify preHandler hook that enforces the rate limit.
   */
  preHandler(options: RateLimitHookOptions = {}) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const key = this.keyFn(request);
      const now = Date.now();

      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { tokens: this.max, lastRefill: now };
        this.buckets.set(key, bucket);
      }

      // Refill tokens based on elapsed time
      const elapsed = now - bucket.lastRefill;
      const refill = (elapsed / this.windowMs) * this.max;
      bucket.tokens = Math.min(this.max, bucket.tokens + refill);
      bucket.lastRefill = now;

      if (bucket.tokens < 1) {
        const retryAfterSec = Math.ceil((((1 - bucket.tokens) / this.max) * this.windowMs) / 1000);
        if (options.onLimit) {
          return options.onLimit(request, reply, retryAfterSec);
        }
        reply.header("Retry-After", String(retryAfterSec));
        return reply.status(429).send(this.errorBody(retryAfterSec));
      }

      bucket.tokens -= 1;
      return undefined;
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }

  /** Drop every bucket without stopping the cleanup timer. Used by tests. */
  reset(): void {
    this.buckets.clear();
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

// Pre-configured limiters for admin endpoints
export const healthCheckSweepLimit = new RateLimiter({ max: 1, windowMs: 10_000 });

export const serviceActionLimit = new RateLimiter({
  max: 1,
  windowMs: 10_000,
  keyFn: (req) => {
    const params = req.params as Record<string, string>;
    const peer = req.socket?.remoteAddress ?? "unknown";
    return `${req.ip}|${peer}|${params.service ?? params.id ?? "global"}`;
  },
});

export const storeInstallLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const systemMaintenanceLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const userModerationLimit = new RateLimiter({ max: 5, windowMs: 60_000 });

export const emailTestLimit = new RateLimiter({ max: 1, windowMs: 15_000 });

/**
 * Broad floor for any public API request. Sized so a normal interactive
 * session (tile fetches, place lookups, autocomplete) never hits it, but
 * scripted abuse from a single IP gets capped quickly.
 *
 * Tunable per deployment via `RATE_LIMIT_PUBLIC_MAX` / `RATE_LIMIT_PUBLIC_WINDOW_MS`.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export const publicApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_PUBLIC_MAX", 600),
  windowMs: envInt("RATE_LIMIT_PUBLIC_WINDOW_MS", 60_000),
});

/**
 * Public status has a dedicated IP bucket because each cache refresh fans out
 * to deployment dependencies. Keep this contract fixed at 60 requests/minute;
 * the in-process snapshot and shared response cache reduce probe work further.
 */
export const statusPublicApiLimit = new RateLimiter({ max: 60, windowMs: 60_000 });

/**
 * Tight limiter for CPU- or quota-expensive endpoints that fan out to
 * upstream services (Valhalla isochrone, MOTIS, geocoding, photo / review
 * aggregation).
 */
export const expensivePublicApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_EXPENSIVE_MAX", 60),
  windowMs: envInt("RATE_LIMIT_EXPENSIVE_WINDOW_MS", 60_000),
});

/**
 * Separate expensive bucket for personal-timeline day reads. The route runs
 * this hook only after authentication has populated `request.userId`, keeping
 * users behind the same address isolated and avoiding Dawarich credentials as
 * an identity. It intentionally shares the expensive tier's deployment knobs
 * while retaining independent buckets from unrelated fan-out endpoints.
 */
export const timelineDayApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_EXPENSIVE_MAX", 60),
  windowMs: envInt("RATE_LIMIT_EXPENSIVE_WINDOW_MS", 60_000),
  keyFn: (request) => {
    const userId = (request as FastifyRequest & { userId?: unknown }).userId;
    if (typeof userId !== "string" || !userId) {
      throw new Error("Timeline day rate limit requires an authenticated user");
    }
    return userId;
  },
});

/**
 * Generous limiter for tile proxies and tile-adjacent static assets
 * (style.json, sprites, fonts, vector and raster tiles). These endpoints
 * serve cacheable, idempotent content and are pulled in bursts of 30-60
 * per viewport change, so they cannot share a bucket with the rest of the
 * API without starving unrelated traffic (autocomplete, place lookups,
 * directions) during heavy map use. Responses already carry a one-week
 * `Cache-Control: public`, so a CDN in front absorbs the steady-state
 * load and the origin only sees cold misses plus abuse.
 *
 * Tunable per deployment via `RATE_LIMIT_TILE_MAX` / `RATE_LIMIT_TILE_WINDOW_MS`.
 */
export const tilePublicApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_TILE_MAX", 1800),
  windowMs: envInt("RATE_LIMIT_TILE_WINDOW_MS", 60_000),
});

/**
 * Strict limiter for auth flows (sign-in, sign-up, OTP, password reset,
 * email-verification dispatch). Prevents credential stuffing and email
 * amplification. Uses the default composite (`req.ip` + socket peer) key;
 * better-auth applies its own per-account limits in addition to this.
 */
export const authLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_AUTH_MAX", 10),
  windowMs: envInt("RATE_LIMIT_AUTH_WINDOW_MS", 60_000),
});

/**
 * Bucket key for a signed-in user. The raw id is digested so the in-memory
 * bucket map holds no account identifier, and the limiter must therefore be
 * registered *after* the auth hook has set `request.userId`.
 */
function userDigestKeyFn(req: FastifyRequest): string {
  const userId = (req as FastifyRequest & { userId?: string }).userId;
  if (!userId) return defaultKeyFn(req);
  return createHash("sha256").update(userId).digest("hex");
}

/**
 * Per-user limits for OpenStreetMap contributions. Reads and previews are
 * generous enough for normal editing; the two limiters that cause an upstream
 * write are deliberately tight, because abuse here lands in a public database.
 */
/** The shared contribution error body, so a 429 matches every other failure. */
function osmContributionLimitBody(retryAfterSeconds: number) {
  return {
    code: "RATE_LIMITED",
    message: "You have made too many contribution requests. Try again shortly.",
    retryAfterSeconds,
  };
}

function osmContributionLimiter(prefix: string, max: number, windowMs: number): RateLimiter {
  return new RateLimiter({
    max: envInt(`RATE_LIMIT_OSM_CONTRIBUTION_${prefix}_MAX`, max),
    windowMs: envInt(`RATE_LIMIT_OSM_CONTRIBUTION_${prefix}_WINDOW_MS`, windowMs),
    keyFn: userDigestKeyFn,
    errorBody: osmContributionLimitBody,
  });
}

export const osmContributionReadLimit = osmContributionLimiter("READ", 60, 600_000);
export const osmContributionPreviewLimit = osmContributionLimiter("PREVIEW", 30, 600_000);
export const osmContributionPublishLimit = osmContributionLimiter("PUBLISH", 10, 600_000);
export const osmContributionNoteLimit = osmContributionLimiter("NOTE", 5, 600_000);

/** Every contribution limiter, so tests can isolate cases. */
export const osmContributionLimiters = [
  osmContributionReadLimit,
  osmContributionPreviewLimit,
  osmContributionPublishLimit,
  osmContributionNoteLimit,
] as const;
