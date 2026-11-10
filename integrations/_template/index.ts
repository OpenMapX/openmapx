// Integration: __ID__
//
// This file is generated from integrations/_template. Replace the example
// route below with your real implementation.
//
// Quick-start references:
//   docs/docs/developer/writing-an-integration.md
//   packages/integration-framework/src/types.ts  (IntegrationContext API)
//
// Once you have real data sources, add them to manifest.json > dataSources[]
// (one entry per upstream API you call). The legal-tables gate requires every
// data source to be declared there with the full attribution fields — see the
// docs page above for the complete field list and guidance.

import type { IntegrationContext } from "@openmapx/integration-framework";

const CACHE_TTL = 3600; // seconds — adjust to how quickly your data changes

export function setup(ctx: IntegrationContext): void {
  // Register a GET route. The host serves it at:
  //   GET /api/integrations/__ID__/ping
  //
  // ctx.registerRoute(method, path, handler, options?)
  //   options.requireAuth = true  → host rejects unauthenticated calls with 401
  ctx.registerRoute("GET", "/ping", async (_req, reply) => {
    const cacheKey = "ping-result";

    // ctx.cache is namespaced per integration (int:__ID__:<key>), so keys
    // cannot collide with other integrations.
    //
    // withCache returns the cached value, or runs the loader once for every
    // concurrent caller and stores its result. An admin cache clear while the
    // loader runs keeps the late result out of the cache. When results need
    // different TTLs, for example a shorter one for "not found", capture a
    // writer before the upstream request instead of calling ctx.cache.set
    // after it (pnpm check-integration-cache-writes refuses that):
    //
    //   const writer = await captureCacheWriter(ctx.cache);
    //   const found = await fetchFromUpstream();
    //   await writer.set(cacheKey, found ?? { notFound: true }, found ? CACHE_TTL : 300);
    const result = await ctx.cache.withCache(cacheKey, CACHE_TTL, async () => {
      // Replace this with a real fetch to your upstream API.
      // ctx.log is a structured logger already tagged with the integration id.
      ctx.log.info("Fetching from upstream");
      return { ok: true, integration: "__ID__" };
    });

    reply.send(result);
  });
}
