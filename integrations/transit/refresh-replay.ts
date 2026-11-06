import type { IntegrationContext } from "@openmapx/integration-framework";

interface RefreshResponse {
  status: number;
  body: unknown;
}
const unavailable = (): RefreshResponse => ({
  status: 503,
  body: { error: "Itinerary refresh temporarily unavailable", retryable: true },
});

/** Only call with an authenticated handle ID. Successful bodies live for two minutes. */
export function createRefreshReplay(ctx: IntegrationContext) {
  const local = new Map<string, Promise<RefreshResponse>>();
  return async (id: string, work: () => Promise<RefreshResponse>): Promise<RefreshResponse> => {
    const key = `transit-refresh-result:${id}`;
    const run = async () => {
      const cached = await ctx.cache.get<RefreshResponse>(key);
      if (cached) return cached;
      const store = ctx.upstreamRuntime;
      const lease = store
        ? await store.acquireLease(`transit-refresh-lock:${id}`, 30_000)
        : undefined;
      if (store && !lease) {
        // Another replica owns this handle. Await its result briefly, then retry with the same handle.
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const result = await ctx.cache.get<RefreshResponse>(key);
          if (result) return result;
        }
        return unavailable();
      }
      try {
        const completed = await ctx.cache.get<RefreshResponse>(key);
        if (completed) return completed;
        const startedAt = Date.now();
        const writer = (await ctx.cache.captureWriter?.()) ?? ctx.cache;
        const result = await work();
        if (store && Date.now() - startedAt >= 25_000) return unavailable();
        if (result.status === 200) {
          await writer.set(key, result, 120);
          const stored = await ctx.cache.get<RefreshResponse>(key);
          if (JSON.stringify(stored) !== JSON.stringify(result)) return unavailable();
          // Never retire the old state until the exact successor body is durable.
          await ctx.cache.del(`transit-refresh:${id}`);
        }
        return result;
      } finally {
        if (store && lease) await store.releaseLease(`transit-refresh-lock:${id}`, lease.token);
      }
    };
    if (ctx.upstreamRuntime) {
      try {
        return await run();
      } catch {
        return unavailable();
      }
    }
    const pending = local.get(id);
    if (pending) return pending;
    const task = run()
      .catch(unavailable)
      .finally(() => local.delete(id));
    local.set(id, task);
    return task;
  };
}
