import type { CacheClient } from "@openmapx/mobility-core/cache";

/** In-memory read-through cache with the host's clone-on-write semantics. */
export function memoryCache(): CacheClient {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (values.get(key) as T) ?? null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    del: async (key) => {
      values.delete(key);
    },
    withCache: async function <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) {
      const previous = await this.get<T>(key);
      if (previous !== null) return previous;
      const data = await load(new AbortController().signal);
      await this.set(key, data);
      return data;
    },
  };
}
