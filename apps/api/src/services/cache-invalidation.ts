import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { redis } from "../redis";

export interface CacheInvalidationEvent {
  available: boolean;
}

type Listener = (event: CacheInvalidationEvent) => void;
type Subscriber = Pick<EventEmitter, "on" | "off"> & {
  status: string;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  ping(): Promise<unknown>;
  disconnect(): void;
};

/** Only the Redis operations owned by this service; injectable without a network. */
interface InvalidationRedis {
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: (string | number)[]): Promise<unknown>;
  duplicate(options: { enableOfflineQueue: boolean }): Subscriber;
}

// Control metadata deliberately lives outside the disposable int:/cache: globs.
const EPOCH_KEY = "openmapx:cache-control:epoch";
const CLEAR_LEASES_KEY = "openmapx:cache-control:clears";
const CLEAR_LEASE_MS = 30_000;
const CLEAR_RENEW_MS = 10_000;
const CHANNEL = "openmapx:cache-control:invalidate";
const REDIS_NOW = `local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)`;
const BEGIN_CLEAR = `-- begin-clear
${REDIS_NOW}
local epoch = redis.call('INCR', KEYS[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZADD', KEYS[2], now + ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return epoch`;
const RENEW_CLEAR = `-- renew-clear
${REDIS_NOW}
local expiry = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not expiry or tonumber(expiry) <= now then return 0 end
redis.call('ZADD', KEYS[2], now + ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return 1`;
const FINISH_CLEAR = `-- finish-clear
${REDIS_NOW}
local expiry = redis.call('ZSCORE', KEYS[2], ARGV[1])
local valid = expiry and tonumber(expiry) > now
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('INCR', KEYS[1])
if valid then return 1 else return 0 end`;
const WRITE_IF_CURRENT = `-- write-if-current
${REDIS_NOW}
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) > 0 then return 0 end
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
if tonumber(ARGV[3]) == 0 then
  redis.call('SET', KEYS[2], ARGV[2])
else
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
end
return 1`;
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;

export async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Invalidation connection timed out")),
          HEARTBEAT_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// Redis globs include [], ?, * and escapes. Their literal leading segment is
// sufficient to conservatively clear an entire affected integration's L1.
function overlaps(prefix: string, pattern: string): boolean {
  const literal = pattern.split(/[?*[\\]/, 1)[0] ?? "";
  return prefix.startsWith(literal) || literal.startsWith(prefix);
}

// Pub/Sub flushes are asynchronous across workers. The shared write fence is
// atomic; local reads cannot be linearizable with a remote administrative clear.
export class CacheInvalidation {
  private readonly origin = randomUUID();
  private readonly listeners = new Set<{ prefix: string; listener: Listener }>();
  private available: boolean;
  private generation = 0;
  private subscriber: Subscriber | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private connectionGeneration = 0;
  private checking = false;

  constructor(private readonly client: InvalidationRedis | null) {
    this.available = client === null;
  }

  subscribe(prefix: string, listener: Listener): () => void {
    const subscription = { prefix, listener };
    this.listeners.add(subscription);
    listener({ available: this.available });
    return () => {
      this.listeners.delete(subscription);
    };
  }

  private notify(patterns?: string[]): void {
    this.generation++;
    for (const { prefix, listener } of this.listeners) {
      if (!patterns || patterns.some((pattern) => overlaps(prefix, pattern))) {
        listener({ available: this.available });
      }
    }
  }

  private unavailable = (): void => {
    this.connectionGeneration++;
    if (this.available) {
      this.available = false;
      this.notify();
    }
  };

  private onMessage = (channel: string, message: string): void => {
    if (channel !== CHANNEL) return;
    try {
      const data: unknown = JSON.parse(message);
      if (typeof data !== "object" || data === null || !("patterns" in data)) return;
      const { origin, patterns } = data as { origin?: unknown; patterns: unknown };
      if (
        origin === this.origin ||
        !Array.isArray(patterns) ||
        !patterns.every((p) => typeof p === "string")
      )
        return;
      this.notify(patterns);
    } catch {
      // This is a dedicated application channel; malformed data cannot clear scopes.
    }
  };

  private acknowledge = async (): Promise<void> => {
    const subscriber = this.subscriber;
    const generation = ++this.connectionGeneration;
    if (subscriber?.status !== "ready") return;
    try {
      await withDeadline(subscriber.subscribe(CHANNEL));
      if (this.subscriber !== subscriber || generation !== this.connectionGeneration) return;
      this.available = true;
      this.notify(); // Clear anything acquired while events could have been missed.
    } catch {
      if (this.subscriber === subscriber && generation === this.connectionGeneration)
        this.unavailable();
    }
  };

  private onReady = (): void => {
    void this.acknowledge();
  };

  async start(): Promise<void> {
    if (!this.client || this.subscriber) return;
    const subscriber = this.client.duplicate({ enableOfflineQueue: false });
    this.subscriber = subscriber;
    subscriber.on("message", this.onMessage);
    subscriber.on("ready", this.onReady);
    subscriber.on("close", this.unavailable);
    subscriber.on("end", this.unavailable);
    subscriber.on("error", this.unavailable);
    await this.acknowledge();
    this.heartbeat = setInterval(() => {
      void this.checkConnection();
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private async checkConnection(): Promise<void> {
    const subscriber = this.subscriber;
    if (!subscriber || this.checking) return;
    this.checking = true;
    try {
      await withDeadline(subscriber.ping());
      if (!this.available) await this.acknowledge();
    } catch {
      this.unavailable();
    } finally {
      this.checking = false;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const subscriber = this.subscriber;
    this.subscriber = null;
    this.unavailable();
    if (!subscriber) return;
    try {
      if (subscriber.status === "ready") await withDeadline(subscriber.unsubscribe(CHANNEL));
    } catch {
      // Shutdown must also finish when the connection cannot acknowledge UNSUBSCRIBE.
    } finally {
      subscriber.disconnect();
      subscriber.off("message", this.onMessage);
      subscriber.off("ready", this.onReady);
      subscriber.off("close", this.unavailable);
      subscriber.off("end", this.unavailable);
      subscriber.off("error", this.unavailable);
    }
  }

  async captureEpoch(): Promise<string | null> {
    if (!this.client) return String(this.generation);
    try {
      return (await withDeadline(this.client.get(EPOCH_KEY))) ?? "0";
    } catch {
      return null;
    } // A failed capture must never authorize a shared write.
  }

  async writeIfCurrent(
    key: string,
    serialized: string,
    ttlSeconds: number,
    epoch: string | null,
  ): Promise<void> {
    if (!this.client || epoch === null) return;
    await withDeadline(
      this.client.eval(
        WRITE_IF_CURRENT,
        3,
        EPOCH_KEY,
        key,
        CLEAR_LEASES_KEY,
        epoch,
        serialized,
        ttlSeconds,
      ),
    );
  }

  private async broadcast(patterns: string[]): Promise<void> {
    this.notify(patterns);
    if (this.client) {
      try {
        await withDeadline(
          this.client.publish(CHANNEL, JSON.stringify({ origin: this.origin, patterns })),
        );
      } catch (error) {
        this.unavailable();
        throw error;
      }
    }
  }

  private async clearLease(script: string, token: string): Promise<unknown> {
    if (!this.client) return 1;
    try {
      return await withDeadline(
        this.client.eval(script, 2, EPOCH_KEY, CLEAR_LEASES_KEY, token, CLEAR_LEASE_MS),
      );
    } catch (error) {
      this.unavailable();
      throw error;
    }
  }

  private async finishClear(token: string, renewalFailure: unknown): Promise<void> {
    if ((await this.clearLease(FINISH_CLEAR, token)) !== 1) {
      this.unavailable();
      throw new Error("Cache clear lease expired before deletion completed");
    }
    if (renewalFailure) throw renewalFailure;
  }

  async invalidate<T>(patterns: string[], action: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    await this.clearLease(BEGIN_CLEAR, token);
    let renewalFailure: unknown;
    let renewing: Promise<void> | undefined;
    const renewal = this.client
      ? setInterval(() => {
          if (renewing || renewalFailure) return;
          renewing = this.clearLease(RENEW_CLEAR, token)
            .then((valid) => {
              if (valid !== 1) throw new Error("Cache clear lease expired during deletion");
            })
            .catch((error: unknown) => {
              renewalFailure = error;
              this.unavailable();
            })
            .finally(() => {
              renewing = undefined;
            });
        }, CLEAR_RENEW_MS)
      : undefined;
    renewal?.unref?.();
    try {
      await this.broadcast(patterns);
      return await action();
    } finally {
      clearInterval(renewal);
      await renewing;
      // Independent leases preserve concurrent clears; finishing also fences
      // fills acquired during this deletion. Expired workers cannot claim success.
      try {
        await this.finishClear(token, renewalFailure);
      } finally {
        await this.broadcast(patterns);
      }
    }
  }
}

export const cacheInvalidation = new CacheInvalidation(redis);
