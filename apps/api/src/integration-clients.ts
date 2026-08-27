import {
  DEFAULT_FETCH_JSON_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  readBoundedJsonResponse,
} from "@openmapx/core";
import type {
  CacheClient,
  HttpClient,
  HttpClientOptions,
  LiveStoreClient,
  Logger,
} from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { redis } from "./redis";
import { BoundedSingleFlight } from "./utils/bounded-single-flight";
import { httpCacheKey } from "./utils/http-cache-key";
import { createIntegrationLogger } from "./utils/integration-logger";

const integrationSingleFlight = new BoundedSingleFlight(1_000);

function cacheTtlWithJitter(ttlSeconds: number): number {
  if (ttlSeconds < 60) return ttlSeconds;
  return Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
}

export function createHttpClient(_log: Logger): HttpClient {
  const signalFor = (options?: HttpClientOptions, operationSignal = options?.signal) => {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    return operationSignal ? AbortSignal.any([operationSignal, timeout]) : timeout;
  };
  const readJson = <T>(response: Response, options?: HttpClientOptions) =>
    readBoundedJsonResponse<T>(response, {
      maxBytes: options?.maxResponseBytes ?? DEFAULT_FETCH_JSON_MAX_BYTES,
      label: "integration HTTP response",
    });
  return {
    async get<T>(url: string, options?: HttpClientOptions): Promise<T> {
      const u = new URL(url);
      if (options?.params) {
        for (const [k, v] of Object.entries(options.params)) {
          if (v !== undefined) u.searchParams.set(k, String(v));
        }
      }

      if (options?.cache?.ttl) {
        const cacheKey = httpCacheKey(u.toString(), options?.headers);
        const cacheTtl = options.cache.ttl;
        if (redis) {
          try {
            const cached = await redis.get(cacheKey);
            if (cached) {
              const maxBytes = options.maxResponseBytes ?? DEFAULT_FETCH_JSON_MAX_BYTES;
              if (Buffer.byteLength(cached, "utf8") <= maxBytes) return JSON.parse(cached) as T;
            }
          } catch {
            // cache miss
          }
        }

        const flightKey = [
          "http",
          cacheKey,
          cacheTtl,
          options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
          options.maxResponseBytes ?? DEFAULT_FETCH_JSON_MAX_BYTES,
        ].join(":");
        return integrationSingleFlight.run(
          flightKey,
          async (flightSignal) => {
            const res = await fetch(u.toString(), {
              headers: options?.headers,
              signal: signalFor(options, flightSignal),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            const data = await readJson<T>(res, options);
            if (redis) {
              await redis
                .setex(cacheKey, cacheTtlWithJitter(cacheTtl), JSON.stringify(data))
                .catch(() => {});
            }
            return data;
          },
          options.signal,
        );
      }

      const res = await fetch(u.toString(), {
        headers: options?.headers,
        signal: signalFor(options),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return readJson<T>(res, options);
    },

    async post<T>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: signalFor(options),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return readJson<T>(res, options);
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
    async withCache<T>(
      key: string,
      ttlSeconds: number,
      fn: (operationSignal: AbortSignal) => Promise<T>,
      callerSignal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ): Promise<T> {
      const k = `int:${prefix}:${key}`;
      if (redis) {
        try {
          const cached = await redis.get(k);
          if (cached) {
            const parsed = JSON.parse(cached) as T;
            if (shouldCache?.(parsed) ?? true) return parsed;
            await redis.del(k).catch(() => {});
          }
        } catch {
          // cache miss
        }
      }
      return integrationSingleFlight.run(
        `cache:${k}:${ttlSeconds}`,
        async (operationSignal) => {
          const result = await fn(operationSignal);
          if (redis && (shouldCache?.(result) ?? true)) {
            await redis
              .setex(k, cacheTtlWithJitter(ttlSeconds), JSON.stringify(result))
              .catch(() => {});
          }
          return result;
        },
        callerSignal,
      );
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
