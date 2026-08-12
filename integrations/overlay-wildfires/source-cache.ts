import type { IntegrationContext } from "@openmapx/integration-framework";

export interface CachedLoadResult<T> {
  value: T;
  fetchedAt: string;
  stale: boolean;
}

interface CachedValue<T> {
  value: T;
  fetchedAt: string;
}

interface LoadWithFreshAndStaleCacheOptions<T> {
  key: string;
  freshTtlSeconds: number;
  staleTtlSeconds: number;
  load: () => Promise<T>;
}

export async function loadWithFreshAndStaleCache<T>(
  ctx: IntegrationContext,
  options: LoadWithFreshAndStaleCacheOptions<T>,
): Promise<CachedLoadResult<T>> {
  const fresh = await ctx.cache.get<CachedValue<T>>(`${options.key}:fresh`);
  if (fresh) return { ...fresh, stale: false };

  try {
    const cached = { value: await options.load(), fetchedAt: new Date().toISOString() };
    await ctx.cache.set(`${options.key}:fresh`, cached, options.freshTtlSeconds);
    await ctx.cache.set(`${options.key}:stale`, cached, options.staleTtlSeconds);
    return { ...cached, stale: false };
  } catch (error) {
    const stale = await ctx.cache.get<CachedValue<T>>(`${options.key}:stale`);
    if (stale) return { ...stale, stale: true };
    throw error;
  }
}
