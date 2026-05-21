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
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RateLimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.keyFn = options.keyFn ?? defaultKeyFn;

    // Periodically clean stale buckets every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * Returns a Fastify preHandler hook that enforces the rate limit.
   */
  preHandler() {
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
        reply.header("Retry-After", String(retryAfterSec));
        return reply.status(429).send({
          error: "Too many requests",
          retryAfter: retryAfterSec,
        });
      }

      bucket.tokens -= 1;
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
 * Tight limiter for CPU- or quota-expensive endpoints that fan out to
 * upstream services (Valhalla isochrone, MOTIS, geocoding, photo / review
 * aggregation).
 */
export const expensivePublicApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_EXPENSIVE_MAX", 60),
  windowMs: envInt("RATE_LIMIT_EXPENSIVE_WINDOW_MS", 60_000),
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
