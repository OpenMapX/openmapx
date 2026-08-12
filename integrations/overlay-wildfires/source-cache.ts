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

export interface LoadWithFreshAndStaleCacheOptions<T> {
  key: string;
  freshTtlSeconds: number;
  staleTtlSeconds: number;
  /** Defaults to true to preserve existing stale-cache behavior. */
  shouldUseStaleOnError?: (error: unknown) => boolean;
  load: () => Promise<T>;
}

const inFlightLoads = new WeakMap<
  IntegrationContext,
  Map<string, Promise<CachedLoadResult<unknown>>>
>();

export async function loadWithFreshAndStaleCache<T>(
  ctx: IntegrationContext,
  options: LoadWithFreshAndStaleCacheOptions<T>,
): Promise<CachedLoadResult<T>> {
  const fresh = await ctx.cache.get<CachedValue<T>>(`${options.key}:fresh`);
  if (fresh) return { ...fresh, stale: false };

  let loads = inFlightLoads.get(ctx);
  if (!loads) {
    loads = new Map();
    inFlightLoads.set(ctx, loads);
  }

  const existing = loads.get(options.key) as Promise<CachedLoadResult<T>> | undefined;
  if (existing) return existing;

  let inFlight: Promise<CachedLoadResult<T>>;
  inFlight = loadAndCache(ctx, options).finally(() => {
    if (loads.get(options.key) === inFlight) loads.delete(options.key);
  });
  loads.set(options.key, inFlight as Promise<CachedLoadResult<unknown>>);
  return inFlight;
}

async function loadAndCache<T>(
  ctx: IntegrationContext,
  options: LoadWithFreshAndStaleCacheOptions<T>,
): Promise<CachedLoadResult<T>> {
  let value: T;
  try {
    value = await options.load();
  } catch (error) {
    if (options.shouldUseStaleOnError && !options.shouldUseStaleOnError(error)) throw error;
    const stale = await ctx.cache.get<CachedValue<T>>(`${options.key}:stale`);
    if (stale) return { ...stale, stale: true };
    throw error;
  }

  const cached = { value, fetchedAt: new Date().toISOString() };
  await Promise.allSettled([
    ctx.cache.set(`${options.key}:fresh`, cached, options.freshTtlSeconds),
    ctx.cache.set(`${options.key}:stale`, cached, options.staleTtlSeconds),
  ]);
  return { ...cached, stale: false };
}
