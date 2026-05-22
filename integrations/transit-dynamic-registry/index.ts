import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { getAdapter } from "./adapters.js";
import { setCache, setGithubToken } from "./fetcher.js";
import { setRedis } from "./hafas-mgate.js";
import { registry } from "./registry.js";

const BASE_ATTRIBUTION: Attribution[] = [
  {
    sourceId: "jsdelivr",
    name: "JSDelivr CDN (transport-apis catalog)",
    url: "https://cdn.jsdelivr.net/",
    spdxLicense: "MIT",
    licenseUrl: "https://www.jsdelivr.com/terms/terms-of-use",
  },
];

function buildAttributionFor(
  entryId: string,
  entryAttribution: {
    name: string;
    homepage?: string;
    license?: string;
  },
): Attribution[] {
  return [
    ...BASE_ATTRIBUTION,
    {
      sourceId: `dyn:${entryId}`,
      name: entryAttribution.name,
      url: entryAttribution.homepage,
      spdxLicense: entryAttribution.license,
    },
  ];
}

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
          url: entry.attribution.homepage,
          license: entry.attribution.license,
        }
      : null;

    const attribution = entry.attribution
      ? buildAttributionFor(entry.id, entry.attribution)
      : BASE_ATTRIBUTION;

    const wrap = <T>(data: T) => withAttribution(data, attribution, freshnessNow());
    const wrapRT = <T>(data: T) =>
      withAttribution(data, attribution, freshnessNow({ hasRealtimeData: true }));

    ctx.registerTransitProvider({
      id: `dyn:${entry.id}`,
      prefix: entry.prefix,
      coverage: { bbox: entry.bbox },
      priority: 5,
      attribution,
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

  // Start periodic refresh
  registry.startRefresh();
  ctx.onShutdown(async () => registry.stopRefresh());
}

export type { ProtocolAdapter } from "./adapter-types";
export { getAdapter } from "./adapters.js";
// Re-export registry and types for consumers
export { registry } from "./registry.js";
export type { CoverageTier, ProtocolType, RegistryEntry } from "./registry-types";
