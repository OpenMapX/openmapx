import type { IntegrationContext } from "@openmapx/integration-framework";
import { assertRideProviderContract } from "@openmapx/integration-framework";
import { type CatalogEntry, createGofsCatalog } from "./catalog.js";
import type { GofsFetchJson } from "./feed.js";
import { createGofsRideProvider } from "./provider.js";

/** Ceiling on how long catalog resolution may hold up API boot. */
const CATALOG_RESOLVE_BUDGET_MS = 10_000;

/**
 * GOFS ride provider integration. Every feed the catalog resolves — from
 * MobilityData's upstream registry, our verified supplement, or the operator's
 * own list — becomes one ride provider offering that system's service brands,
 * wait times, fares and booking links.
 *
 * Feeds are fetched through the SSRF-safe downloader: their URLs come from a
 * third-party registry and from operator input, neither of which is trusted.
 *
 * `fetchJson` is injectable for tests only — the host calls `setup(ctx)` and
 * gets the real downloader, the same arrangement `createGofsFeedClient` and
 * `createGofsRideProvider` use.
 */
export async function setup(ctx: IntegrationContext, fetchJson?: GofsFetchJson): Promise<void> {
  // Resolving the catalog fetches the registry and probes every entry, and
  // integrations load sequentially — so an unresponsive host would otherwise
  // hold up API boot for as long as its TCP timeouts take. Bound it: a feed
  // that cannot answer within the budget is simply not offered this time
  // round, which is the same outcome as failing its probe.
  const feeds = await Promise.race([
    createGofsCatalog(ctx, fetchJson).resolveFeeds(),
    new Promise<CatalogEntry[]>((resolve) => {
      setTimeout(() => {
        ctx.log.warn(
          `GOFS catalog resolve exceeded ${CATALOG_RESOLVE_BUDGET_MS}ms; starting with no feeds`,
        );
        resolve([]);
      }, CATALOG_RESOLVE_BUDGET_MS).unref?.();
    }),
  ]);

  for (const feed of feeds) {
    const provider = createGofsRideProvider(ctx, feed, fetchJson);
    assertRideProviderContract(provider);
    ctx.registerRideProvider(provider);
  }

  const live = feeds.filter((f) => f.status === "live").length;
  const credentialRequired = feeds.filter((f) => f.status === "credential-required").length;
  ctx.log.info(
    `GOFS feeds registered: ${feeds.length} total, ${live} live, ${credentialRequired} awaiting a credential`,
  );
}
