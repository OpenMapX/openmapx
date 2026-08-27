/**
 * Generic merge strategies for domain orchestrators.
 * Each function takes a lazy getProviders() factory so providers registered
 * after the orchestrator's setup() are picked up at call time.
 */
import {
  mapSettledWithConcurrency,
  type ProviderCallContext,
  ProviderCancelledError,
  runWithProviderDeadline,
} from "./provider-execution";

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_CONCURRENCY = 4;

export interface StrategyExecutionOptions {
  signal?: AbortSignal;
}

export interface FallbackChainOptions<TProvider> {
  isEmpty?: (result: unknown) => boolean;
  onSuccess?: (provider: TProvider) => void;
  onError?: (provider: TProvider, error: unknown) => void;
  timeoutMs?: number;
}

const defaultIsEmpty = (result: unknown): boolean =>
  result === null || result === undefined || (Array.isArray(result) && result.length === 0);

/**
 * Tries each provider in order. Returns the first non-empty/non-null result.
 * Only throws if the last provider throws.
 */
export function createFallbackChain<TProvider>(
  getProviders: () => TProvider[],
  call: (provider: TProvider, context: ProviderCallContext) => Promise<unknown>,
  options?: FallbackChainOptions<TProvider>,
): (execution?: StrategyExecutionOptions) => Promise<unknown> {
  const isEmpty = options?.isEmpty ?? defaultIsEmpty;
  return async (execution = {}) => {
    const providers = getProviders();
    for (let i = 0; i < providers.length; i++) {
      try {
        const result = await runWithProviderDeadline((context) => call(providers[i], context), {
          signal: execution.signal,
          timeoutMs: options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        });
        if (!isEmpty(result)) {
          options?.onSuccess?.(providers[i]);
          return result;
        }
      } catch (err) {
        if (err instanceof ProviderCancelledError) throw err;
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
  maxConcurrency?: number;
  timeoutMs?: number;
}

/**
 * Calls all providers in parallel via Promise.allSettled.
 * Merges results with optional deduplication.
 * Individual provider failures are silently dropped.
 */
export function createMergeAll<TProvider, TItem>(
  getProviders: () => TProvider[],
  call: (provider: TProvider, limit: number, context: ProviderCallContext) => Promise<TItem[]>,
  options?: MergeAllOptions<TItem>,
): (totalLimit?: number, execution?: StrategyExecutionOptions) => Promise<TItem[]> {
  const defaultPerProvider = (total: number, count: number) =>
    Math.max(6, Math.ceil(total / Math.max(count, 1)));

  return async (totalLimit = 20, execution = {}) => {
    const providers = getProviders();
    const perProvider = (options?.perProviderLimit ?? defaultPerProvider)(
      totalLimit,
      providers.length,
    );

    const results = await mapSettledWithConcurrency(
      providers,
      options?.maxConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY,
      (provider) =>
        runWithProviderDeadline((context) => call(provider, perProvider, context), {
          signal: execution.signal,
          timeoutMs: options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        }),
    );
    if (execution.signal?.aborted) throw new ProviderCancelledError();

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
