import type { GtfsCatalogProvider, IntegrationContext } from "@openmapx/integration-framework";
import { type MdbCatalogFeed, toMdbCatalogFeeds } from "./catalog.js";
import { MdbClient } from "./client.js";

interface MdbState {
  client: MdbClient | null;
  includeRtFeeds: boolean;
  includeGbfsFeeds: boolean;
}

let state: MdbState = {
  client: null,
  includeRtFeeds: false,
  includeGbfsFeeds: false,
};

/**
 * Returns the MDB-sourced subset of the global GTFS discovery catalog.
 * Returns `[]` when the integration is disabled, the refresh token is unset,
 * or the upstream is unreachable.
 *
 * Includes GTFS schedule feeds by default. GTFS-RT and GBFS feeds are
 * surfaced when their respective config toggles are on (default: on).
 * Both extra families flow through the same `MdbCatalogFeed` shape; the
 * `dataType` field distinguishes them for downstream filtering.
 */
async function listMdbCatalogFeeds(generation: MdbState): Promise<MdbCatalogFeed[]> {
  const { client, includeRtFeeds, includeGbfsFeeds } = generation;
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

export async function getMdbCatalogFeeds(): Promise<MdbCatalogFeed[]> {
  return listMdbCatalogFeeds(state);
}

/** True when the MDB integration is configured and ready to serve catalog rows. */
export function isMdbConfigured(): boolean {
  return state.client !== null;
}

export async function setup(ctx: IntegrationContext): Promise<void> {
  const refreshToken = (ctx.config.refreshToken as string | undefined)?.trim();
  const generation: MdbState = {
    client: null,
    includeRtFeeds: ctx.config.includeRtFeeds !== false,
    includeGbfsFeeds: ctx.config.includeGbfsFeeds !== false,
  };
  if (!refreshToken) {
    ctx.log.warn(
      "[transit-mobility-database] no refresh token configured; catalog disabled. Set INTEGRATION_TRANSIT_MOBILITY_DATABASE_REFRESHTOKEN or store via the admin secrets API.",
    );
    ctx.onActivate(() => {
      state = generation;
    });
    return;
  }

  generation.client = new MdbClient({
    refreshToken,
    baseUrl: ctx.config.apiBaseUrl as string | undefined,
    cache: ctx.cache,
  });
  ctx.onActivate(() => {
    state = generation;
  });

  // Register discovery through the generic catalog contract so the admin can
  // offer these URLs as operator-source candidates without owning schedules.
  const provider: GtfsCatalogProvider = {
    id: "transit-mobility-database",
    listFeeds: () => listMdbCatalogFeeds(generation),
  };
  ctx.registerGtfsCatalogProvider(provider);

  ctx.onShutdown(async () => {
    generation.client = null;
    if (state === generation)
      state = { client: null, includeRtFeeds: false, includeGbfsFeeds: false };
  });
}

export type { MdbCatalogFeed } from "./catalog.js";
export { normalizeProducerUrl } from "./catalog.js";
