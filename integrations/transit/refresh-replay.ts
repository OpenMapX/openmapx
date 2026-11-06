import type { IntegrationContext } from "@openmapx/integration-framework";

interface RefreshResponse {
  status: number;
  body: unknown;
  /** Server-only policy binding; never included in the route response body. */
  sourceIds?: readonly string[];
}
const unavailable = (): RefreshResponse => ({
  status: 503,
  body: { error: "Itinerary refresh temporarily unavailable", retryable: true },
});

/** Only call with an authenticated handle ID. Successful bodies live for two minutes. */
export function createRefreshReplay(ctx: IntegrationContext) {
  const local = new Map<string, Promise<RefreshResponse>>();
  async function permitted(result: RefreshResponse): Promise<RefreshResponse> {
    if (result.status !== 200) return result;
    let banned: ReadonlySet<string> | undefined;
    try {
      banned = await ctx.getDisallowedSourceIds?.();
    } catch {
      return unavailable();
    }
    if (!banned?.size) return result;
    const receipts = (result.body as { attributions?: Array<{ sourceId?: string }> } | null)
      ?.attributions;
    const ids = [
      ...(result.sourceIds ?? []),
      ...(Array.isArray(receipts)
        ? receipts.flatMap((a) => (typeof a?.sourceId === "string" ? [a.sourceId] : []))
        : []),
    ];
    return ids.some((id) => banned.has(id))
      ? { status: 409, body: { error: "Itinerary source is no longer permitted" } }
      : result;
  }
  return async (id: string, work: () => Promise<RefreshResponse>): Promise<RefreshResponse> => {
    const key = `transit-refresh-result:${id}`;
    const run = async () => {
      const cached = await ctx.cache.get<RefreshResponse>(key);
      if (cached) return permitted(cached);
      const store = ctx.upstreamRuntime;
      const lease = store
        ? await store.acquireLease(`transit-refresh-lock:${id}`, 30_000)
        : undefined;
      if (store && !lease) {
        // Another replica owns this handle. Await its result briefly, then retry with the same handle.
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const result = await ctx.cache.get<RefreshResponse>(key);
          if (result) return permitted(result);
        }
        return unavailable();
      }
      try {
        const completed = await ctx.cache.get<RefreshResponse>(key);
        if (completed) return permitted(completed);
        const startedAt = Date.now();
        const writer = (await ctx.cache.captureWriter?.()) ?? ctx.cache;
        const result = await permitted(await work());
        if (store && Date.now() - startedAt >= 25_000) return unavailable();
        if (result.status === 200) {
          await writer.set(key, result, 120);
          const stored = await ctx.cache.get<RefreshResponse>(key);
          if (JSON.stringify(stored) !== JSON.stringify(result)) return unavailable();
          const checked = await permitted(result);
          if (checked.status !== 200) return checked;
          // Never retire the old state until the exact successor body is durable.
          await ctx.cache.del(`transit-refresh:${id}`);
        }
        return permitted(result);
      } finally {
        if (store && lease) await store.releaseLease(`transit-refresh-lock:${id}`, lease.token);
      }
    };
    if (ctx.upstreamRuntime) {
      try {
        return await permitted(await run());
      } catch {
        return unavailable();
      }
    }
    const pending = local.get(id);
    if (pending) return permitted(await pending);
    const task = run()
      .then(permitted)
      .catch(unavailable)
      .finally(() => local.delete(id));
    local.set(id, task);
    return task;
  };
}
