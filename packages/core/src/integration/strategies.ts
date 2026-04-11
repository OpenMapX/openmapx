/**
 * Generic merge strategies for domain orchestrators.
 * Each function takes a lazy getProviders() factory so providers registered
 * after the orchestrator's setup() are picked up at call time.
 */

export interface FallbackChainOptions<TProvider> {
  isEmpty?: (result: unknown) => boolean;
  onSuccess?: (provider: TProvider) => void;
  onError?: (provider: TProvider, error: unknown) => void;
}

const defaultIsEmpty = (result: unknown): boolean =>
  result === null || result === undefined || (Array.isArray(result) && result.length === 0);

/**
 * Tries each provider in order. Returns the first non-empty/non-null result.
 * Only throws if the last provider throws.
 */
export function createFallbackChain<TProvider>(
  getProviders: () => TProvider[],
  call: (provider: TProvider) => Promise<unknown>,
  options?: FallbackChainOptions<TProvider>,
): () => Promise<unknown> {
  const isEmpty = options?.isEmpty ?? defaultIsEmpty;
  return async () => {
    const providers = getProviders();
    for (let i = 0; i < providers.length; i++) {
      try {
        const result = await call(providers[i]);
        if (!isEmpty(result)) {
          options?.onSuccess?.(providers[i]);
          return result;
        }
      } catch (err) {
        options?.onError?.(providers[i], err);
        if (i === providers.length - 1) throw err;
      }
    }
    return null;
  };
}

export interface MergeAllOptions<TItem> {
  dedup?: (items: TItem[]) => TItem[];
  perProviderLimit?: (totalLimit: number, providerCount: number) => number;
}

/**
 * Calls all providers in parallel via Promise.allSettled.
 * Merges results with optional deduplication.
 * Individual provider failures are silently dropped.
 */
export function createMergeAll<TProvider, TItem>(
  getProviders: () => TProvider[],
  call: (provider: TProvider, limit: number) => Promise<TItem[]>,
  options?: MergeAllOptions<TItem>,
): (totalLimit?: number) => Promise<TItem[]> {
  const defaultPerProvider = (total: number, count: number) =>
    Math.max(6, Math.ceil(total / Math.max(count, 1)));

  return async (totalLimit = 20) => {
    const providers = getProviders();
    const perProvider = (options?.perProviderLimit ?? defaultPerProvider)(
      totalLimit,
      providers.length,
    );

    const results = await Promise.allSettled(providers.map((p) => call(p, perProvider)));

    const all: TItem[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") all.push(...result.value);
    }

    return options?.dedup ? options.dedup(all).slice(0, totalLimit) : all.slice(0, totalLimit);
  };
}

/**
 * Returns the first provider matching a predicate.
 */
export function createFirstWins<TProvider>(
  getProviders: () => TProvider[],
  predicate: (provider: TProvider) => boolean,
): () => TProvider | null {
  return () => {
    for (const provider of getProviders()) {
      if (predicate(provider)) return provider;
    }
    return null;
  };
}
