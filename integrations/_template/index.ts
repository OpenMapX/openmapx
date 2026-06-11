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
    const cached = await ctx.cache.get<{ ok: boolean }>(cacheKey);
    if (cached) {
      reply.send(cached);
      return;
    }

    // Replace this with a real fetch to your upstream API.
    // ctx.log is a structured logger already tagged with the integration id.
    ctx.log.info("Fetching from upstream");

    const result = { ok: true, integration: "__ID__" };

    await ctx.cache.set(cacheKey, result, CACHE_TTL);
    reply.send(result);
  });
}
