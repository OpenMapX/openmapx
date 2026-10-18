import { randomUUID } from "node:crypto";
import {
  DEFAULT_FETCH_JSON_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  readBoundedJsonResponse,
} from "@openmapx/core";
import { readBoundedBinaryResponse } from "@openmapx/core/server";
import type {
  BinaryHttpResponse,
  CacheClient,
  HttpClient,
  HttpClientOptions,
  HttpResponse,
  Logger,
  ResponseOptions,
} from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { redis } from "./redis";
import { cacheInvalidation, withDeadline } from "./services/cache-invalidation";
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
  const urlFor = (url: string, options?: HttpClientOptions) => {
    const parsed = new URL(url);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) parsed.searchParams.set(key, String(value));
      }
    }
    return parsed;
  };
  const selectedHeaders = (
    response: Response,
    allowlist: readonly string[] | undefined,
  ): Readonly<Record<string, string>> => {
    const selected: Record<string, string> = {};
    for (const requested of allowlist ?? []) {
      const key = requested.toLowerCase();
      const value = response.headers.get(requested);
      if (value !== null) selected[key] = value;
    }
    return selected;
  };
  const assertAllowedContentType = (response: Response, options: ResponseOptions): void => {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const allowed = options.contentTypes.map((value) => value.toLowerCase());
    if (!mediaType || !allowed.includes(mediaType)) {
      throw new Error("integration HTTP response has unexpected content type");
    }
  };
  const boundedResponse = async <T>(
    response: Response,
    options: ResponseOptions,
  ): Promise<HttpResponse<T>> => {
    assertAllowedContentType(response, options);
    const body = await readBoundedJsonResponse<T>(response, {
      maxBytes: options.maxBytes,
      label: "integration HTTP response",
      signal: options.signal,
    });
    return {
      status: response.status,
      headers: selectedHeaders(response, options.responseHeaders),
      body,
    };
  };
  return {
    async get<T>(url: string, options?: HttpClientOptions): Promise<T> {
      const u = urlFor(url, options);

      if (options?.cache?.ttl) {
        const cacheKey = httpCacheKey(u.toString(), options?.headers);
        const cacheTtl = options.cache.ttl;
        const epoch = await cacheInvalidation.captureEpoch();
        if (redis) {
          try {
            const cached = await withDeadline(redis.get(cacheKey));
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
          epoch ?? randomUUID(),
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
            if (redis && !flightSignal.aborted) {
              await cacheInvalidation
                .writeIfCurrent(cacheKey, JSON.stringify(data), cacheTtlWithJitter(cacheTtl), epoch)
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

    async getResponse<T>(url: string, options: ResponseOptions): Promise<HttpResponse<T>> {
      const response = await fetch(urlFor(url, options).toString(), {
        headers: options.headers,
        signal: signalFor(options),
        redirect: options.redirect,
      });
      return boundedResponse<T>(response, options);
    },

    async postResponse<T>(
      url: string,
      body: unknown,
      options: ResponseOptions,
    ): Promise<HttpResponse<T>> {
      const response = await fetch(urlFor(url, options).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signalFor(options),
        redirect: options.redirect,
      });
      return boundedResponse<T>(response, options);
    },

    async getBytes(url: string, options: ResponseOptions): Promise<BinaryHttpResponse> {
      const response = await fetch(urlFor(url, options).toString(), {
        headers: options.headers,
        signal: signalFor(options),
        redirect: options.redirect,
      });
      const { data } = await readBoundedBinaryResponse(response, {
        maxBytes: options.maxBytes,
        allowedContentTypes: options.contentTypes.map((value) => value.toLowerCase()),
        label: "integration HTTP response",
      });
      return {
        status: response.status,
        headers: selectedHeaders(response, options.responseHeaders),
        bytes: new Uint8Array(data),
      };
    },
  };
}

export function createCacheClient(prefix: string): CacheClient {
  return {
    onInvalidate: (listener) => cacheInvalidation.subscribe(`int:${prefix}:`, listener),
    async get<T>(key: string): Promise<T | null> {
      if (!redis) return null;
      const val = await withDeadline(redis.get(`int:${prefix}:${key}`));
      return val ? (JSON.parse(val) as T) : null;
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      if (!redis) return;
      // This fences the write invocation. Use withCache to capture the fence
      // before a provider request.
      const epoch = await cacheInvalidation.captureEpoch();
      await cacheInvalidation.writeIfCurrent(
        `int:${prefix}:${key}`,
        JSON.stringify(value),
        ttlSeconds ?? 0,
        epoch,
      );
    },
    async del(key: string): Promise<void> {
      if (!redis) return;
      await withDeadline(redis.del(`int:${prefix}:${key}`));
    },
    async withCache<T>(
      key: string,
      ttlSeconds: number,
      fn: (operationSignal: AbortSignal) => Promise<T>,
      callerSignal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ): Promise<T> {
      const k = `int:${prefix}:${key}`;
      const epoch = await cacheInvalidation.captureEpoch();
      if (redis) {
        try {
          const cached = await withDeadline(redis.get(k));
          if (cached) {
            const parsed = JSON.parse(cached) as T;
            if (shouldCache?.(parsed) ?? true) return parsed;
            await withDeadline(redis.del(k)).catch(() => {});
          }
        } catch {
          // cache miss
        }
      }
      return integrationSingleFlight.run(
        `cache:${epoch ?? randomUUID()}:${k}:${ttlSeconds}`,
        async (operationSignal) => {
          const result = await fn(operationSignal);
          if (redis && !operationSignal.aborted && (shouldCache?.(result) ?? true)) {
            await cacheInvalidation
              .writeIfCurrent(k, JSON.stringify(result), cacheTtlWithJitter(ttlSeconds), epoch)
              .catch(() => {});
          }
          return result;
        },
        callerSignal,
      );
    },
  };
}

export function createLogger(integrationId: string, fastify: FastifyInstance): Logger {
  return createIntegrationLogger(integrationId, fastify);
}
