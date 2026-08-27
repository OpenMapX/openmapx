import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { getAdapter } from "./adapters.js";
import { fetchRegistryEntries, setCache, setGithubToken } from "./fetcher.js";
import { setRedis } from "./hafas-mgate.js";
import { RegistryManager, registry } from "./registry.js";

// Manifest declares the static infrastructure credits (jsdelivr CDN, GitHub
// catalog). Per-upstream credits are constructed at runtime from the dynamic
// registry payload itself — those entries can't be enumerated in a static
// manifest because they're fetched from a community-maintained catalog at
// startup.
const attribution = createManifestAttribution();

function buildAttributionFor(
  entryId: string,
  entryAttribution: {
    name: string;
    homepage?: string;
    license?: string;
  },
): Attribution[] {
  return [
    ...attribution.all(),
    {
      sourceId: `dyn:${entryId}`,
      name: entryAttribution.name,
      url: entryAttribution.homepage,
      spdxLicense: entryAttribution.license,
    },
  ];
}

export async function setup(ctx: IntegrationContext): Promise<void> {
  const githubToken = ctx.config.githubToken as string | undefined;

  // Inject Redis for cached-hafas-client if available via config
  const redisClient = ctx.config.redis;
  const stagedRegistry = new RegistryManager(() =>
    fetchRegistryEntries({ cache: ctx.cache, githubToken }),
  );
  await stagedRegistry
    .initialize(() => fetchRegistryEntries({ cache: ctx.cache, githubToken, preferCache: true }))
    .catch(() => {});

  // Register each discovered entry as a transit provider
  for (const entry of stagedRegistry.listEntries()) {
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
          url: entry.attribution.homepage,
          license: entry.attribution.license,
        }
      : null;

    const entryAttribution = entry.attribution
      ? buildAttributionFor(entry.id, entry.attribution)
      : attribution.all();

    const wrap = <T>(data: T) => withAttribution(data, entryAttribution, freshnessNow());
    const wrapRT = <T>(data: T) =>
      withAttribution(data, entryAttribution, freshnessNow({ hasRealtimeData: true }));

    ctx.registerTransitProvider({
      id: `dyn:${entry.id}`,
      prefix: entry.prefix,
      coverage: { bbox: entry.bbox },
      priority: 5,
      role: "enrichment",
      attribution: entryAttribution,
      capabilities: {
        stops: {
          lookup: false,
          nearby: !!adapter.getStopsNearby,
          bbox: false,
          search: !!adapter.searchByName,
          infrastructure: false,
          platforms: false,
          timetable: false,
        },
        departures: !!adapter.getDepartures,
        arrivals: false,
        routes: { lookup: false, forStop: false, stops: false, geometry: false },
        planning: false,
        vehiclePositions: false,
        vehicleJourney: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        facilities: false,
      },
      getStopsNearby: adapter.getStopsNearby
        ? async (lat, lng, r) => {
            const fn = adapter.getStopsNearby;
            if (!fn) return wrap([]);
            return wrap(await fn(entry as never, lat, lng, r));
          }
        : undefined,
      getDepartures: adapter.getDepartures
        ? async (id, min) => {
            const fn = adapter.getDepartures;
            if (!fn) return wrapRT([]);
            return wrapRT(await fn(entry as never, id, min));
          }
        : undefined,
      searchStopsByName: adapter.searchByName
        ? async (q, limit) => {
            const fn = adapter.searchByName;
            if (!fn) return wrap([]);
            return wrap(await fn(entry as never, q, limit ?? 10));
          }
        : undefined,
      getFeedAttribution: attributionRow
        ? async () => ({ [attributionKey]: attributionRow })
        : undefined,
    });
  }

  let releaseRefresh: (() => void) | null = null;
  ctx.onActivate(() => {
    attribution.set(ctx.manifest.dataSources ?? []);
    setCache(ctx.cache);
    setGithubToken(githubToken);
    // Clear the previous generation's adapter as well as installing a new one;
    // otherwise removing Redis from configuration leaves the retired client
    // reachable through cached-hafas-client after reload.
    setRedis(redisClient ?? null);
    registry.replaceWith(stagedRegistry);
    releaseRefresh = registry.startRefresh();
  });
  ctx.onShutdown(async () => releaseRefresh?.());
}

export type { ProtocolAdapter } from "./adapter-types";
export { getAdapter } from "./adapters.js";
// Re-export registry and types for consumers
export { registry } from "./registry.js";
export type { CoverageTier, ProtocolType, RegistryEntry } from "./registry-types";
