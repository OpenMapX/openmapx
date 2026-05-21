import type { IntegrationContext } from "@openmapx/integration-framework";
import { getAdapter } from "./adapters.js";
import { setCache, setGithubToken } from "./fetcher.js";
import { setRedis } from "./hafas-mgate.js";
import { registry } from "./registry.js";

export async function setup(ctx: IntegrationContext): Promise<void> {
  // Inject the cache client so the fetcher can persist registry data
  setCache(ctx.cache);
  setGithubToken(ctx.config.githubToken as string | undefined);

  // Inject Redis for cached-hafas-client if available via config
  const redisClient = ctx.config.redis;
  if (redisClient) {
    setRedis(redisClient);
  }

  // Initialize the dynamic registry (fetches from GitHub)
  await registry.initialize().catch(() => {});

  // Register each discovered entry as a transit provider
  for (const entry of registry.listEntries()) {
    const adapter = getAdapter(entry.protocol);
    if (!adapter) continue;

    // Capture the real operator attribution from the registry entry so it
    // wins over the integration-level "JSDelivr CDN" dataSource row in
    // /providers. The prefix-without-colon (e.g. "oebb") is what
    // TransitStop.provider carries downstream.
    const attributionKey = entry.prefix.replace(/:$/, "");
    const attributionRow = entry.attribution
      ? {
          label: entry.attribution.name,
          url: entry.attribution.homepage ?? "",
          license: entry.attribution.license,
        }
      : null;

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
      getFeedAttribution: attributionRow
        ? async () => ({ [attributionKey]: attributionRow })
        : undefined,
    });
  }

  // Start periodic refresh
  registry.startRefresh();
  ctx.onShutdown(async () => registry.stopRefresh());
}

export type { ProtocolAdapter } from "./adapter-types";
export { getAdapter } from "./adapters.js";
// Re-export registry and types for consumers
export { registry } from "./registry.js";
export type { CoverageTier, ProtocolType, RegistryEntry } from "./registry-types";
