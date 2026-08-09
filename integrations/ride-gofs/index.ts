import type { IntegrationContext } from "@openmapx/integration-framework";
import { assertRideProviderContract } from "@openmapx/integration-framework";
import { createGofsCatalog } from "./catalog.js";
import type { GofsFetchJson } from "./feed.js";
import { createGofsRideProvider } from "./provider.js";

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
  const feeds = await createGofsCatalog(ctx, fetchJson).resolveFeeds();

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
