import type {
  CacheClient,
  HttpClient,
  HttpClientOptions,
  LiveStoreClient,
  Logger,
} from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { redis } from "./redis";
import { httpCacheKey } from "./utils/http-cache-key";
import { createIntegrationLogger } from "./utils/integration-logger";

export function createHttpClient(_log: Logger): HttpClient {
  return {
    async get<T>(url: string, options?: HttpClientOptions): Promise<T> {
      const u = new URL(url);
      if (options?.params) {
        for (const [k, v] of Object.entries(options.params)) {
          if (v !== undefined) u.searchParams.set(k, String(v));
        }
      }

      if (options?.cache?.ttl && redis) {
        const cacheKey = httpCacheKey(u.toString(), options?.headers);
        try {
          const cached = await redis.get(cacheKey);
          if (cached) return JSON.parse(cached) as T;
        } catch {
          // cache miss
        }

        const res = await fetch(u.toString(), { headers: options?.headers });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as T;
        redis.setex(cacheKey, options.cache.ttl, JSON.stringify(data)).catch(() => {});
        return data;
      }

      const res = await fetch(u.toString(), { headers: options?.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    },

    async post<T>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    },
  };
}

export function createCacheClient(prefix: string): CacheClient {
  return {
    async get<T>(key: string): Promise<T | null> {
      if (!redis) return null;
      const val = await redis.get(`int:${prefix}:${key}`);
      return val ? (JSON.parse(val) as T) : null;
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      if (!redis) return;
      const k = `int:${prefix}:${key}`;
      if (ttlSeconds) {
        await redis.setex(k, ttlSeconds, JSON.stringify(value));
      } else {
        await redis.set(k, JSON.stringify(value));
      }
    },
    async del(key: string): Promise<void> {
      if (!redis) return;
      await redis.del(`int:${prefix}:${key}`);
    },
    async withCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
      if (redis) {
        const k = `int:${prefix}:${key}`;
        try {
          const cached = await redis.get(k);
          if (cached) return JSON.parse(cached) as T;
        } catch {
          // cache miss
        }
        const result = await fn();
        redis.setex(k, ttlSeconds, JSON.stringify(result)).catch(() => {});
        return result;
      }
      return fn();
    },
  };
}

/**
 * Reader for the cross-process `poi:live:<sourceId>` keyspace that
 * `services/data-manager`'s `write-live` stage populates. The keys are
 * deliberately NOT integration-namespaced — data-manager has no notion of
 * integration ids, only the source ids in `@openmapx/poi-source-registry`.
 * Prefixing here would silently miss every write.
 *
 * Process-scoped (one client shared across all integrations); per-key
 * isolation already happens via `@openmapx/poi-source-registry` ensuring
 * source ids are globally unique.
 */
export function createLiveStoreClient(): LiveStoreClient {
  return {
    async hmget<T>(key: string, fields: readonly string[]): Promise<(T | null)[]> {
      if (!redis) return fields.map(() => null);
      if (fields.length === 0) return [];
      const values = await redis.hmget(key, ...fields);
      return values.map((v) => (v ? (JSON.parse(v) as T) : null));
    },
  };
}

export function createLogger(integrationId: string, fastify: FastifyInstance): Logger {
  return createIntegrationLogger(integrationId, fastify);
}
