import { createHash, randomUUID } from "node:crypto";
import type {
  QuotaDecision,
  QuotaWindow,
  UpstreamCacheRead,
  UpstreamCacheTtl,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import { CONSUME_QUOTA_SCRIPT, RELEASE_LEASE_SCRIPT } from "./scripts";

export interface UpstreamRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null>;
  del(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

interface CacheRecord<T> {
  schema: 1;
  storedAt: number;
  softExpiresAt: number;
  hardExpiresAt: number;
  staleIfErrorUntil: number;
  value: T;
}

interface RuntimeOptions {
  namespace: string;
  integrationId: string;
  now?: () => number;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateTtl(ttl: UpstreamCacheTtl): void {
  if (
    !Number.isFinite(ttl.softMs) ||
    !Number.isFinite(ttl.hardMs) ||
    !Number.isFinite(ttl.staleIfErrorMs) ||
    ttl.softMs <= 0 ||
    ttl.softMs > ttl.hardMs ||
    ttl.hardMs > ttl.staleIfErrorMs
  ) {
    throw new Error(
      "Upstream cache TTLs must be finite and ordered soft <= hard <= stale-if-error",
    );
  }
}

function isCacheRecord(value: unknown): value is CacheRecord<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CacheRecord<unknown>>;
  return (
    record.schema === 1 &&
    typeof record.storedAt === "number" &&
    typeof record.softExpiresAt === "number" &&
    typeof record.hardExpiresAt === "number" &&
    typeof record.staleIfErrorUntil === "number" &&
    "value" in record &&
    record.storedAt <= record.softExpiresAt &&
    record.softExpiresAt <= record.hardExpiresAt &&
    record.hardExpiresAt <= record.staleIfErrorUntil
  );
}

export function createRedisUpstreamRuntime(
  redis: UpstreamRedisClient,
  options: RuntimeOptions,
): UpstreamRuntime {
  const now = options.now ?? Date.now;
  const prefix = `upstream:${options.namespace}:${options.integrationId}`;
  const keyFor = (kind: string, value: string) => `${prefix}:${kind}:${digest(value)}`;

  return {
    async read<T>(key: string, at = now()): Promise<UpstreamCacheRead<T>> {
      const redisKey = keyFor("cache", key);
      let raw: string | null;
      try {
        raw = await redis.get(redisKey);
      } catch {
        return { state: "miss", diagnostic: "store_unavailable" };
      }
      if (!raw) return { state: "miss" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await redis.del(redisKey).catch(() => 0);
        return { state: "miss", diagnostic: "invalid_record" };
      }
      if (!isCacheRecord(parsed)) {
        await redis.del(redisKey).catch(() => 0);
        return { state: "miss", diagnostic: "invalid_record" };
      }
      const record = parsed as CacheRecord<T>;
      if (at >= record.staleIfErrorUntil) {
        await redis.del(redisKey).catch(() => 0);
        return { state: "miss" };
      }
      return {
        state:
          at < record.softExpiresAt
            ? "fresh"
            : at < record.hardExpiresAt
              ? "stale"
              : "stale-if-error",
        value: record.value,
        storedAt: record.storedAt,
        softExpiresAt: record.softExpiresAt,
        hardExpiresAt: record.hardExpiresAt,
        staleIfErrorUntil: record.staleIfErrorUntil,
      };
    },

    async write<T>(key: string, value: T, ttl: UpstreamCacheTtl): Promise<void> {
      validateTtl(ttl);
      const storedAt = now();
      const record: CacheRecord<T> = {
        schema: 1,
        storedAt,
        softExpiresAt: storedAt + ttl.softMs,
        hardExpiresAt: storedAt + ttl.hardMs,
        staleIfErrorUntil: storedAt + ttl.staleIfErrorMs,
        value,
      };
      await redis.set(
        keyFor("cache", key),
        JSON.stringify(record),
        "PX",
        Math.ceil(ttl.staleIfErrorMs),
      );
    },

    async acquireLease(key: string, ttlMs: number): Promise<{ token: string } | null> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Lease TTL must be positive");
      const token = randomUUID();
      try {
        const result = await redis.set(keyFor("lease", key), token, "PX", Math.ceil(ttlMs), "NX");
        return result === "OK" ? { token } : null;
      } catch {
        return null;
      }
    },

    async releaseLease(key: string, token: string): Promise<void> {
      if (!token) return;
      await redis.eval(RELEASE_LEASE_SCRIPT, 1, keyFor("lease", key), token).catch(() => 0);
    },

    async consumeQuota(input: {
      bucket: string;
      cost: number;
      windows: readonly QuotaWindow[];
    }): Promise<QuotaDecision> {
      if (!Number.isInteger(input.cost) || input.cost <= 0)
        throw new Error("Quota cost must be positive");
      if (input.windows.length === 0) throw new Error("At least one quota window is required");
      const at = now();
      const ids = new Set<string>();
      for (const window of input.windows) {
        if (
          !window.id ||
          ids.has(window.id) ||
          !Number.isInteger(window.limit) ||
          window.limit <= 0 ||
          !Number.isInteger(window.durationMs) ||
          window.durationMs <= 0
        ) {
          throw new Error("Quota windows require unique ids and positive integer limits/durations");
        }
        ids.add(window.id);
      }
      const keys = input.windows.map((window) => {
        const period = Math.floor(at / window.durationMs);
        return keyFor("quota", `${input.bucket}:${window.id}:${period}`);
      });
      const argv = [
        String(input.cost),
        String(at),
        ...input.windows.flatMap((window) => [String(window.limit), String(window.durationMs)]),
      ];
      try {
        const raw = await redis.eval(CONSUME_QUOTA_SCRIPT, keys.length, ...keys, ...argv);
        const parsed = JSON.parse(String(raw)) as {
          allowed: boolean;
          remaining: number[];
          retryAt: number | null;
        };
        return {
          allowed: parsed.allowed === true,
          remaining: Object.fromEntries(
            input.windows.map((window, index) => [window.id, parsed.remaining[index] ?? 0]),
          ),
          retryAt: typeof parsed.retryAt === "number" ? parsed.retryAt : null,
        };
      } catch {
        return { allowed: false, remaining: {}, retryAt: null, diagnostic: "store_unavailable" };
      }
    },
  };
}
