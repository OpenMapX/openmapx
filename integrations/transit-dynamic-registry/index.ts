import type { BBox } from "@openmapx/core";
import {
  captureTransitContributors,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { withAttribution } from "@openmapx/mobility-core/result";
import { OtpError } from "@openmapx/otp-client";
import { getAdapter } from "./adapters.js";
import { fetchRegistryEntries, setCache, setGithubToken } from "./fetcher.js";
import { setRedis } from "./hafas-mgate.js";
import { RegistryManager, registry } from "./registry.js";
import type { RegistryEntry } from "./registry-types.js";

// Provider receipts belong to each captured catalog entry; infrastructure disclosures
// remain in the manifest rather than replacing the actual operator credit.
function buildAttributionFor(
  entryId: string,
  entryAttribution: {
    name: string;
    homepage?: string;
    license?: string;
  },
): Attribution[] {
  return [
    {
      sourceId: `dyn:${entryId}`,
      name: entryAttribution.name,
      url: entryAttribution.homepage,
      licensing: licensingFromDeclaration(
        // The catalogue writes "todo" where an entry's licence is yet to be found.
        /^todo$/i.test(entryAttribution.license?.trim() ?? "")
          ? undefined
          : entryAttribution.license,
        undefined,
        entryAttribution.name,
      ),
    },
  ];
}

/**
 * The area an entry is the source for: its live coverage, else its regular
 * coverage. ÖBB's is Austria, though its timetable spans Europe.
 */
function homeArea(entry: RegistryEntry): BBox {
  const tiers = entry.coverage.tiers;
  return (
    tiers.find((tier) => tier.level === "realtimeCoverage")?.bbox ??
    tiers.find((tier) => tier.level === "regularCoverage")?.bbox ??
    entry.coverage.bbox
  );
}

export async function setup(ctx: IntegrationContext): Promise<void> {
  const generation = new AbortController();
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
  for (const entry of stagedRegistry.snapshotEntries()) {
    const adapter = getAdapter(entry.protocol, {
      http: ctx.http,
      upstreamRuntime: ctx.upstreamRuntime,
      signal: generation.signal,
      digitransitApiKey: ctx.config.digitransitApiKey,
      isSourceAllowed: async (owner, sourceId) => {
        const denied = await ctx.getDisallowedSourceIds?.();
        return (
          !denied?.has(ctx.id) &&
          !denied?.has(`dyn:${owner.id}`) &&
          !denied?.has(sourceId) &&
          !denied?.has("regional-operators")
        );
      },
    });
    if (!adapter) continue;

    // Capture the real operator attribution from the registry entry so it
    // wins over the integration-level "JSDelivr CDN" dataSource row in
    // /providers. The prefix-without-colon (e.g. "oebb") is what
    // TransitStop.provider carries downstream.
    const attributionKey = entry.prefix.replace(/:$/, "");
    const attributionRow = entry.attribution
      ? buildAttributionFor(entry.id, entry.attribution)[0]
      : null;

    const entryAttribution = entry.attribution
      ? buildAttributionFor(entry.id, entry.attribution)
      : [];

    async function assertPublication() {
      await adapter?.assertAvailable?.(entry);
    }
    // This fence must run in the synchronous publishing continuation, after every await.
    function assertNotRetired() {
      if (entry.protocol === "otpGraphQl" && generation.signal.aborted)
        throw new OtpError("cancelled");
    }
    const wrap = <T>(data: T) => {
      assertNotRetired();
      return withAttribution(
        captureTransitContributors(data, entryAttribution),
        entryAttribution,
        freshnessNow(),
      );
    };
    const wrapRT = <T>(data: T, dataAsOf?: string) =>
      withAttribution(captureTransitContributors(data, entryAttribution), entryAttribution, {
        ...freshnessNow({ hasRealtimeData: true }),
        ...(dataAsOf ? { dataAsOf } : {}),
      });

    ctx.registerTransitProvider({
      id: `dyn:${entry.id}`,
      prefix: entry.prefix,
      coverage: { bbox: entry.coverage.bbox, home: homeArea(entry) },
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
            const result = await fn(entry, lat, lng, r);
            await assertPublication();
            return wrap(result);
          }
        : undefined,
      getDepartures: adapter.getDepartures
        ? async (id, min) => {
            const fn = adapter.getDepartures;
            if (!fn) return wrapRT([]);
            const { departures, dataAsOf } = await fn(entry, id, min);
            await assertPublication();
            assertNotRetired();
            return entry.protocol === "otpGraphQl"
              ? withAttribution(
                  captureTransitContributors(departures, entryAttribution),
                  entryAttribution,
                  freshnessNow({
                    hasRealtimeData: departures.some(
                      (call) => call.expectedAt !== undefined || call.canceled === true,
                    ),
                  }),
                )
              : wrapRT(departures, dataAsOf);
          }
        : undefined,
      searchStopsByName: adapter.searchByName
        ? async (q, limit) => {
            const fn = adapter.searchByName;
            if (!fn) return wrap([]);
            const result = await fn(entry, q, limit ?? 10);
            await assertPublication();
            return wrap(result);
          }
        : undefined,
      getFeedAttribution: attributionRow
        ? async () => ({ [attributionKey]: attributionRow })
        : undefined,
    });
  }

  let releaseRefresh: (() => void) | null = null;
  ctx.onActivate(() => {
    setCache(ctx.cache);
    setGithubToken(githubToken);
    // Clear the previous generation's adapter as well as installing a new one;
    // otherwise removing Redis from configuration leaves the retired client
    // reachable through cached-hafas-client after reload.
    setRedis(redisClient ?? null);
    registry.replaceWith(stagedRegistry);
    releaseRefresh = registry.startRefresh();
  });
  ctx.onShutdown(async () => {
    generation.abort();
    releaseRefresh?.();
  });
}

export type { ProtocolAdapter } from "./adapter-types";
export { getAdapter } from "./adapters.js";
// Re-export registry and types for consumers
export { registry } from "./registry.js";
export type { CoverageTier, ProtocolType, RegistryEntry } from "./registry-types";
