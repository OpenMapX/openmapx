import { createHash } from "node:crypto";
import { isIP } from "node:net";
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
   *  of `request.ip` + socket peer — see `requestNetworkKey`). */
  keyFn?: (request: FastifyRequest) => string;
  /**
   * Optional 429 body. Routes with their own closed error taxonomy pass one so
   * a throttled response is the same shape as every other typed failure.
   */
  errorBody?: (retryAfterSeconds: number) => unknown;
  /**
   * Most buckets kept at once. Past it the least recently used bucket is
   * dropped, which only refills that client early.
   */
  maxBuckets?: number;
}

const DEFAULT_MAX_BUCKETS = 50_000;

export interface RateLimitHookOptions {
  onLimit?: (request: FastifyRequest, reply: FastifyReply, retryAfterSeconds: number) => unknown;
}

function ipv6Hextets(address: string): number[] {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const [head = "", rest] = text.split("::", 2);
  const headParts = head ? head.split(":") : [];
  const restParts = rest ? rest.split(":") : [];
  const zeros = rest === undefined ? 0 : 8 - headParts.length - restParts.length;
  return [...headParts, ...Array<string>(zeros).fill("0"), ...restParts].map((part) =>
    Number.parseInt(part, 16),
  );
}

/**
 * Collapses an address to the unit one client controls. IPv4 stays as is, an
 * IPv4-mapped IPv6 form becomes its IPv4 address, and any other IPv6 address
 * becomes its /64: a single host is routinely given a whole /64, so keying the
 * exact address would hand it billions of fresh buckets. Anything that is not
 * an address shares one bucket, so it cannot be varied to dodge the limit.
 */
export function clientAddressKey(address: string | undefined): string {
  if (!address) return "unknown";
  const withoutZone = address.split("%", 1)[0] ?? "";
  const family = isIP(withoutZone);
  if (family === 4) return withoutZone;
  if (family !== 6) return "invalid";
  const hextets = ipv6Hextets(withoutZone);
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${hextets
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

/**
 * Default rate-limit key. Combines:
 *  - `request.ip` — the trusted-proxy-derived client IP. Fastify reads
 *    `X-Forwarded-For` only when the socket peer is inside
 *    `TRUST_PROXY_RANGES`, so behind the shipped proxy this is the real
 *    client and a direct client cannot choose it.
 *  - `request.socket.remoteAddress` — the actual TCP peer, which the
 *    attacker can never spoof (it's whatever socket the connection landed on).
 *
 * Both halves pass through {@link clientAddressKey}, so every address in one
 * IPv6 /64 lands in the same bucket whether or not a proxy is in front.
 *
 * The composite key keeps per-client granularity behind a real proxy (where
 * the socket peer is the proxy IP and `req.ip` varies per client) AND
 * prevents XFF rotation from cycling fresh buckets when no proxy is in
 * front (where the socket peer is the attacker and stays constant across
 * forged XFF values). Behind a NAT'd shared proxy two distinct clients
 * still get separate keys because their `request.ip` differs.
 */
export function requestNetworkKey(req: FastifyRequest): string {
  return `${clientAddressKey(req.ip)}|${clientAddressKey(req.socket?.remoteAddress)}`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly keyFn: (request: FastifyRequest) => string;
  private readonly errorBody: (retryAfterSeconds: number) => unknown;
  private readonly maxBuckets: number;
  private lastCleanup = Date.now();

  constructor(options: RateLimiterOptions) {
    this.max = options.max;
    this.maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
    this.windowMs = options.windowMs;
    this.keyFn = options.keyFn ?? requestNetworkKey;
    this.errorBody =
      options.errorBody ?? ((retryAfter: number) => ({ error: "Too many requests", retryAfter }));
  }

  /**
   * Returns a Fastify preHandler hook that enforces the rate limit.
   */
  preHandler(options: RateLimitHookOptions = {}) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const key = this.keyFn(request);
      const now = Date.now();

      // Re-inserting on every hit keeps the map ordered from least to most
      // recently used, which both the sweep and the size cap rely on.
      let bucket = this.buckets.get(key);
      if (bucket) {
        this.buckets.delete(key);
      } else {
        bucket = { tokens: this.max, lastRefill: now };
        this.cleanupIfDue(now);
        this.evictOverflow();
      }
      this.buckets.set(key, bucket);

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

  // Limiters are module singletons that outlive any one application, so stale
  // buckets are swept when a new one is added instead of on a timer. The map
  // is in least-recently-used order, so the sweep stops at the first bucket
  // that is still live.
  private cleanupIfDue(now: number): void {
    if (now - this.lastCleanup < 5 * 60_000) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill <= this.windowMs * 2) break;
      this.buckets.delete(key);
    }
  }

  // A flood of distinct clients cannot grow the map past its cap: the least
  // recently used bucket makes room for the new one.
  private evictOverflow(): void {
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }

  /** Number of buckets currently held. */
  get size(): number {
    return this.buckets.size;
  }

  /** Drop every bucket. Used by tests. */
  reset(): void {
    this.buckets.clear();
  }

  destroy(): void {
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
    return `${requestNetworkKey(req)}|${params.service ?? params.id ?? "global"}`;
  },
});

export const extensionPreviewLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const storeInstallLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

/** Update checks are read-only host inspection; keep them from consuming the apply token. */
export const systemUpdateCheckLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const systemMaintenanceLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const userModerationLimit = new RateLimiter({ max: 5, windowMs: 60_000 });

export const emailTestLimit = new RateLimiter({ max: 1, windowMs: 15_000 });

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Requests that matched no route. Nothing legitimate asks for missing routes
 * at volume, so this bucket is small and separate: a scanner is capped
 * without draining the client's real budget, and nothing unrouted is ever
 * unlimited.
 *
 * Tunable via `RATE_LIMIT_UNMATCHED_MAX` / `RATE_LIMIT_UNMATCHED_WINDOW_MS`.
 */
export const unmatchedRouteLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_UNMATCHED_MAX", 120),
  windowMs: envInt("RATE_LIMIT_UNMATCHED_WINDOW_MS", 60_000),
});

/**
 * Broad floor for any public API request. Sized so a normal interactive
 * session (tile fetches, place lookups, autocomplete) never hits it, but
 * scripted abuse from a single IP gets capped quickly.
 *
 * Tunable per deployment via `RATE_LIMIT_PUBLIC_MAX` / `RATE_LIMIT_PUBLIC_WINDOW_MS`.
 */
export const publicApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_PUBLIC_MAX", 600),
  windowMs: envInt("RATE_LIMIT_PUBLIC_WINDOW_MS", 60_000),
});

/**
 * Admission floor for integration dispatcher methods whose bodies Fastify
 * parses before the matched route can apply its declared limiter. This bucket
 * is independent from that late operation tier; GET and HEAD never use it, so
 * bursty integration tile traffic retains the dedicated tile budget.
 */
export const integrationIngressApiLimit = new RateLimiter({
  max: envInt("RATE_LIMIT_INTEGRATION_INGRESS_MAX", 60),
  windowMs: envInt("RATE_LIMIT_INTEGRATION_INGRESS_WINDOW_MS", 60_000),
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
  if (!userId) return requestNetworkKey(req);
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

/**
 * Public share-link resolution. One indexed SELECT per hit, but the endpoint
 * is anonymous and token-guessing must stay expensive on top of the token's
 * 256-bit entropy. Uses the default composite (`req.ip` + socket peer) key.
 */
export const shareResolveLimit = new RateLimiter({ max: 60, windowMs: 60_000 });

/**
 * Share-link minting/rotation for a signed-in user. Registered after the auth
 * hook so `userDigestKeyFn` sees `request.userId`.
 */
export const shareMintLimit = new RateLimiter({
  max: 20,
  windowMs: 600_000,
  keyFn: userDigestKeyFn,
});
