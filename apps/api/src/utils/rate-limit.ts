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
  /** Optional function to derive a key from the request (default: IP). */
  keyFn?: (request: FastifyRequest) => string;
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
    this.keyFn = options.keyFn ?? ((req) => req.ip);

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
    return `${req.ip}:${params.service ?? params.id ?? "global"}`;
  },
});

export const storeInstallLimit = new RateLimiter({ max: 1, windowMs: 30_000 });

export const userModerationLimit = new RateLimiter({ max: 5, windowMs: 60_000 });

export const emailTestLimit = new RateLimiter({ max: 1, windowMs: 15_000 });
