interface ClientBudget {
  active: number;
  lastRefill: number;
  tokens: number;
}

export interface ImageProxyBudgetOptions {
  maxBytes: number;
  windowMs: number;
  maxConcurrentPerClient: number;
  maxConcurrentGlobal: number;
  now?: () => number;
}

export interface ImageProxyBudgetLease {
  consume(bytes: number): { allowed: boolean; retryAfterSeconds: number };
  refund(bytes: number): void;
  release(): void;
}

/**
 * Per-process resource budget for the public image proxy. Bytes use a token
 * bucket per network client; concurrency is bounded both per client and across
 * the process so forged browser headers cannot create unbounded upstream work.
 */
export class ImageProxyBudget {
  private readonly clients = new Map<string, ClientBudget>();
  private readonly now: () => number;
  private activeGlobal = 0;
  private acquisitions = 0;

  constructor(private readonly options: ImageProxyBudgetOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (name === "now") continue;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`ImageProxyBudget ${name} must be positive`);
      }
    }
    this.now = options.now ?? Date.now;
  }

  tryAcquire(clientKey: string): ImageProxyBudgetLease | null {
    const now = this.now();
    this.acquisitions += 1;
    if (this.acquisitions % 256 === 0) this.cleanup(now);
    if (this.activeGlobal >= this.options.maxConcurrentGlobal) return null;

    const client = this.client(clientKey, now);
    if (client.active >= this.options.maxConcurrentPerClient) return null;
    client.active += 1;
    this.activeGlobal += 1;
    let released = false;

    return {
      consume: (bytes) => this.consume(client, bytes),
      refund: (bytes) => this.refund(client, bytes),
      release: () => {
        if (released) return;
        released = true;
        client.active = Math.max(0, client.active - 1);
        this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      },
    };
  }

  private client(key: string, now: number): ClientBudget {
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = { active: 0, lastRefill: now, tokens: this.options.maxBytes };
    this.clients.set(key, created);
    return created;
  }

  private consume(
    client: ClientBudget,
    bytes: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error("ImageProxyBudget bytes must be a non-negative finite number");
    }
    if (bytes === 0) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.now();
    const elapsed = Math.max(0, now - client.lastRefill);
    client.tokens = Math.min(
      this.options.maxBytes,
      client.tokens + (elapsed / this.options.windowMs) * this.options.maxBytes,
    );
    client.lastRefill = now;
    if (client.tokens >= bytes) {
      client.tokens -= bytes;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const missing = bytes - client.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((missing / this.options.maxBytes) * (this.options.windowMs / 1000)),
      ),
    };
  }

  private refund(client: ClientBudget, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error("ImageProxyBudget refund must be a non-negative finite number");
    }
    client.tokens = Math.min(this.options.maxBytes, client.tokens + bytes);
  }

  private cleanup(now: number): void {
    for (const [key, client] of this.clients) {
      if (client.active === 0 && now - client.lastRefill > this.options.windowMs * 2) {
        this.clients.delete(key);
      }
    }
  }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createImageProxyBudgetFromEnv(): ImageProxyBudget {
  return new ImageProxyBudget({
    maxBytes: envPositiveInt("RATE_LIMIT_IMAGE_PROXY_MAX_BYTES", 128 * 1024 * 1024),
    windowMs: envPositiveInt("RATE_LIMIT_IMAGE_PROXY_WINDOW_MS", 60_000),
    maxConcurrentPerClient: envPositiveInt("RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_PER_CLIENT", 16),
    maxConcurrentGlobal: envPositiveInt("RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_GLOBAL", 64),
  });
}
