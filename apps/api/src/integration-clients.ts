import { randomUUID } from "node:crypto";
import {
  DEFAULT_FETCH_JSON_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithRedirects,
  readBoundedJsonResponse,
} from "@openmapx/core";
import type {
  BinaryHttpResponse,
  CacheClient,
  HttpClient,
  HttpClientOptions,
  HttpResponse,
  Logger,
  ResponseOptions,
  StreamHttpResponse,
} from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { redis } from "./redis";
import { cacheInvalidation, withDeadline } from "./services/cache-invalidation";
import { BoundedSingleFlight } from "./utils/bounded-single-flight";
import { httpCacheKey } from "./utils/http-cache-key";
import {
  boundedIntegrationResponseStream,
  bufferIntegrationResponse,
} from "./utils/integration-http-response";
import { createIntegrationLogger } from "./utils/integration-logger";

const integrationSingleFlight = new BoundedSingleFlight(1_000);

function cacheTtlWithJitter(ttlSeconds: number): number {
  if (ttlSeconds < 60) return ttlSeconds;
  return Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
}

/** Retain late-response ownership while caller cancellation interrupts redirect cleanup. */
function awaitHttpResponse(operation: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      (response) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          void response.body?.cancel(signal.reason).catch(() => {});
          reject(signal.reason);
        } else resolve(response);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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
  const request = async (
    url: string,
    options: ResponseOptions,
    init: RequestInit = {},
  ): Promise<{ response: Response; signal: AbortSignal }> => {
    const signal = signalFor(options);
    const initialUrl = urlFor(url, options).toString();
    const redirect = options.redirect;
    if (typeof redirect === "object") {
      if (!redirect.allowedHosts.length) {
        throw new Error("integration HTTP redirect allowlist must not be empty");
      }
      let previousOrigin = new URL(initialUrl).origin;
      let credentialsRemoved = false;
      const response = await awaitHttpResponse(
        fetchWithRedirects(initialUrl, {
          ...init,
          headers: init.headers ?? options.headers,
          signal,
          allowedRedirectHosts: [...redirect.allowedHosts],
          follow203Redirect: redirect.follow203,
          maxRedirects: redirect.maxRedirects,
          validateRedirectUrl: (next, previous) => {
            if (
              next.username ||
              next.password ||
              (previous.protocol === "https:" && next.protocol !== "https:")
            ) {
              // The core helper's default rejection includes the full target URL.
              throw new Error("integration HTTP redirect target rejected");
            }
            return true;
          },
          cleanupDeadlineAt: Date.now() + (options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
          fetchImplementation: (input, nextInit) => {
            const origin = new URL(input).origin;
            credentialsRemoved ||= origin !== previousOrigin;
            previousOrigin = origin;
            const headers = new Headers(nextInit?.headers);
            if (credentialsRemoved) {
              headers.delete("authorization");
              headers.delete("cookie");
              headers.delete("proxy-authorization");
            }
            return fetch(input, { ...nextInit, headers });
          },
        }),
        signal,
      );
      return { response, signal };
    }
    signal.throwIfAborted();
    const response = await fetch(initialUrl, {
      ...init,
      headers: init.headers ?? options.headers,
      signal,
      redirect,
    });
    return { response, signal };
  };
  const boundedResponse = async <T>(
    response: Response,
    options: ResponseOptions,
    signal: AbortSignal,
  ): Promise<HttpResponse<T>> => {
    const stream = boundedIntegrationResponseStream(response, options, signal);
    const headers = new Headers(response.headers);
    if (!headers.has("content-type") && options.fallbackContentType) {
      headers.set("content-type", options.fallbackContentType);
    }
    const body = await readBoundedJsonResponse<T>(new Response(stream, { headers }), {
      maxBytes: options.maxBytes,
      label: "integration HTTP response",
      signal,
    });
    return {
      status: response.status,
      headers: selectedHeaders(response, options.responseHeaders),
      body,
    };
  };
  const textResponse = async (
    url: string,
    options: ResponseOptions,
    init?: RequestInit,
  ): Promise<HttpResponse<string>> => {
    const { response, signal } = await request(url, options, init);
    const stream = boundedIntegrationResponseStream(response, options, signal, true);
    return {
      status: response.status,
      headers: selectedHeaders(response, options.responseHeaders),
      body: new TextDecoder().decode(await bufferIntegrationResponse(stream)),
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
      const { response, signal } = await request(url, options);
      return boundedResponse<T>(response, options, signal);
    },

    async postResponse<T>(
      url: string,
      body: unknown,
      options: ResponseOptions,
    ): Promise<HttpResponse<T>> {
      const { response, signal } = await request(url, options, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return boundedResponse<T>(response, options, signal);
    },

    async getBytes(url: string, options: ResponseOptions): Promise<BinaryHttpResponse> {
      const { response, signal } = await request(url, options);
      const stream = boundedIntegrationResponseStream(response, options, signal);
      return {
        status: response.status,
        headers: selectedHeaders(response, options.responseHeaders),
        bytes: await bufferIntegrationResponse(stream),
      };
    },

    getText: (url, options) => textResponse(url, options),

    postText: (url, body, options) => textResponse(url, options, { method: "POST", body }),

    async getStream(url: string, options: ResponseOptions): Promise<StreamHttpResponse> {
      const { response, signal } = await request(url, options);
      return {
        status: response.status,
        headers: selectedHeaders(response, options.responseHeaders),
        stream: boundedIntegrationResponseStream(response, options, signal, true),
      };
    },
  };
}

export function createCacheClient(prefix: string): CacheClient {
  const write = async (
    epoch: string | null,
    key: string,
    value: unknown,
    ttlSeconds = 0,
  ): Promise<void> => {
    if (!redis) return;
    await cacheInvalidation.writeIfCurrent(
      `int:${prefix}:${key}`,
      JSON.stringify(value),
      ttlSeconds,
      epoch,
    );
  };
  return {
    async captureWriter() {
      const epoch = await cacheInvalidation.captureEpoch();
      return { set: (key, value, ttl) => write(epoch, key, value, ttl) };
    },
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
      await write(epoch, key, value, ttlSeconds);
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
