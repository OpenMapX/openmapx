import type { QuotaDecision, QuotaWindow } from "./upstream-runtime";

export interface LocalQuotaMeter {
  /**
   * Checks every window and, only when all have room, charges `cost` to each:
   * the same fixed-window semantics as `UpstreamRuntime.consumeQuota`, counted
   * in this process.
   */
  consume(
    input: { bucket: string; cost: number; windows: readonly QuotaWindow[] },
    now?: number,
  ): QuotaDecision;
}

const DEFAULT_MAX_COUNTERS = 10_000;

/**
 * An in-process stand-in for the shared quota store, for a consumer to use
 * while the store is unreachable. It keeps the upstream metered (per process,
 * so N replicas admit up to N times the limit) instead of refusing every
 * request or letting them through unmetered. Counters are bounded: past
 * `maxCounters` the oldest is dropped.
 */
export function createLocalQuotaMeter(options: { maxCounters?: number } = {}): LocalQuotaMeter {
  const maxCounters = Math.max(1, options.maxCounters ?? DEFAULT_MAX_COUNTERS);
  const counters = new Map<string, { period: number; used: number }>();

  return {
    consume(input, now = Date.now()) {
      const entries = input.windows.map((window) => {
        const key = `${input.bucket}\u0000${window.id}`;
        const period = Math.floor(now / window.durationMs);
        const counter = counters.get(key);
        const used = counter && counter.period === period ? counter.used : 0;
        return { window, key, period, used };
      });
      const denied = entries.filter(({ window, used }) => used + input.cost > window.limit);
      if (denied.length > 0) {
        const retryAt = Math.max(
          ...denied.map(({ window, period }) => (period + 1) * window.durationMs),
        );
        return {
          allowed: false,
          remaining: Object.fromEntries(
            entries.map(({ window, used }) => [window.id, Math.max(0, window.limit - used)]),
          ),
          retryAt,
        };
      }
      for (const { key, period, used } of entries) {
        counters.delete(key);
        while (counters.size >= maxCounters) {
          const oldest = counters.keys().next();
          if (oldest.done) break;
          counters.delete(oldest.value);
        }
        counters.set(key, { period, used: used + input.cost });
      }
      return {
        allowed: true,
        remaining: Object.fromEntries(
          entries.map(({ window, used }) => [window.id, window.limit - used - input.cost]),
        ),
        retryAt: null,
      };
    },
  };
}
