import type { CacheClient, UpstreamRuntime } from "@openmapx/integration-framework";
import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { createHttpClient } from "../../../apps/api/src/integration-clients.js";
import { BoundedSingleFlight } from "../../../apps/api/src/utils/bounded-single-flight.js";

/** Exercise the production host transport against each suite's intercepted fetch. */
export const testHttp = () => createHttpClient(createNoopLogger());
export const allowQuota = (): UpstreamRuntime => ({
  read: async () => ({ state: "miss" }),
  write: async () => {},
  acquireLease: async () => ({ token: "fixture" }),
  releaseLease: async () => {},
  consumeQuota: async () => ({ allowed: true, remaining: {}, retryAt: null }),
});
export function memoryCache() {
  const flights = new BoundedSingleFlight(100);
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  const listeners = new Set<(event: { available: boolean }) => void>();
  let epoch = 0;
  let available = true;
  const cache: CacheClient = {
    async captureWriter() {
      const at = epoch;
      return {
        async set(key, value, ttl) {
          if (at === epoch) await cache.set(key, value, ttl);
        },
      };
    },
    onInvalidate(listener) {
      listeners.add(listener);
      listener({ available });
      return () => {
        listeners.delete(listener);
      };
    },
    async get<T>(key: string) {
      const entry = store.get(key);
      return available && entry && entry.expiresAt > Date.now() ? (entry.value as T) : null;
    },
    async set(key, value, ttl = 60) {
      if (available) store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    async del(key) {
      store.delete(key);
    },
    async withCache<T>(
      key: string,
      ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ) {
      signal?.throwIfAborted();
      const at = epoch;
      const entry = store.get(key);
      if (available && entry && entry.expiresAt > Date.now()) return entry.value as T;
      return flights.run(
        `${at}:${key}`,
        async (operationSignal) => {
          const result = await load(operationSignal);
          operationSignal.throwIfAborted();
          if (at === epoch && (!shouldCache || shouldCache(result)))
            await cache.set(key, result, ttl);
          return result;
        },
        signal,
      );
    },
  };
  return {
    cache,
    store,
    invalidate(nextAvailable = true) {
      epoch++;
      available = nextAvailable;
      store.clear();
      for (const listener of listeners) listener({ available });
    },
  };
}
