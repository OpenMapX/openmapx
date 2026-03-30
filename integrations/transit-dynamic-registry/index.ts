import type { IntegrationContext } from "@openmapx/core";
import { getAdapter } from "../../apps/api/src/services/transit/adapters/index.js";
import { registry } from "../../apps/api/src/services/transit/registry/index.js";

export async function setup(ctx: IntegrationContext): Promise<void> {
  // Initialize the dynamic registry (fetches from GitHub)
  await registry.initialize().catch(() => {});

  // Register each discovered entry as a transit provider
  for (const entry of registry.listEntries()) {
    const adapter = getAdapter(entry.protocol);
    if (!adapter) continue;

    ctx.registerProvider("transit", {
      id: `dyn:${entry.id}`,
      prefix: entry.prefix,
      coverage: { bbox: entry.bbox },
      priority: 5,
      getStopsNearby: adapter.getStopsNearby
        ? (lat: number, lng: number, r: number) =>
            adapter.getStopsNearby?.(entry as never, lat, lng, r)
        : undefined,
      getDepartures: adapter.getDepartures
        ? (id: string, min: number) => adapter.getDepartures?.(entry as never, id, min)
        : undefined,
      searchByName: adapter.searchByName
        ? (q: string, limit: number) => adapter.searchByName?.(entry as never, q, limit)
        : undefined,
    });
  }

  // Start periodic refresh
  registry.startRefresh();
  ctx.onShutdown(async () => registry.stopRefresh());
}
