import type { GtfsCatalogProvider, IntegrationContext } from "@openmapx/integration-framework";
import { type MdbCatalogFeed, toMdbCatalogFeeds } from "./catalog.js";
import { MdbClient } from "./client.js";

interface MdbState {
  client: MdbClient | null;
  includeRtFeeds: boolean;
  includeGbfsFeeds: boolean;
}

const state: MdbState = {
  client: null,
  includeRtFeeds: false,
  includeGbfsFeeds: false,
};

/**
 * Returns the MDB-sourced subset of the global GTFS catalog. Called by
 * `apps/api/src/services/gtfs/catalog.ts` alongside the Swiss + Transitous
 * fetchers. Returns `[]` when the integration is disabled, the refresh
 * token is unset, or the upstream is unreachable — the catalog merge
 * tolerates this silently.
 *
 * Includes GTFS schedule feeds by default. GTFS-RT and GBFS feeds are
 * surfaced when their respective config toggles are on (default: on).
 * Both extra families flow through the same `MdbCatalogFeed` shape; the
 * `dataType` field distinguishes them for downstream filtering.
 */
export async function getMdbCatalogFeeds(): Promise<MdbCatalogFeed[]> {
  const { client, includeRtFeeds, includeGbfsFeeds } = state;
  if (!client) return [];

  const tasks: Array<Promise<unknown[]>> = [client.listGtfsFeeds()];
  if (includeRtFeeds) tasks.push(client.listGtfsRtFeeds());
  if (includeGbfsFeeds) tasks.push(client.listGbfsFeeds());

  try {
    const results = await Promise.all(tasks);
    const merged = ([] as unknown[]).concat(...results);
    // biome-ignore lint/suspicious/noExplicitAny: typed boundary at toMdbCatalogFeeds
    return toMdbCatalogFeeds(merged as any[]);
  } catch (err) {
    console.warn("[transit-mobility-database] catalog fetch failed:", err);
    return [];
  }
}

/** True when the MDB integration is configured and ready to serve catalog rows. */
export function isMdbConfigured(): boolean {
  return state.client !== null;
}

export async function setup(ctx: IntegrationContext): Promise<void> {
  const refreshToken = (ctx.config.refreshToken as string | undefined)?.trim();
  if (!refreshToken) {
    ctx.log.warn(
      "[transit-mobility-database] no refresh token configured; catalog disabled. Set INTEGRATION_TRANSIT_MOBILITY_DATABASE_REFRESHTOKEN or store via the admin secrets API.",
    );
    state.client = null;
    return;
  }

  state.client = new MdbClient({
    refreshToken,
    baseUrl: ctx.config.apiBaseUrl as string | undefined,
    cache: ctx.cache,
  });
  state.includeRtFeeds = ctx.config.includeRtFeeds !== false;
  state.includeGbfsFeeds = ctx.config.includeGbfsFeeds !== false;

  // Register a no-op provider under the `gtfs-catalog` domain so the
  // integration appears under the right domain in the admin UI and its
  // dataSources (CC0 attribution) propagate via the standard scan. The
  // actual catalog fetch is consumed by services/gtfs/catalog.ts via the
  // exported `getMdbCatalogFeeds` helper.
  const provider: GtfsCatalogProvider = {
    id: "transit-mobility-database",
    listFeeds: getMdbCatalogFeeds,
  };
  ctx.registerGtfsCatalogProvider(provider);

  ctx.onShutdown(async () => {
    state.client = null;
  });
}

export type { MdbCatalogFeed } from "./catalog.js";
export { normalizeProducerUrl } from "./catalog.js";
