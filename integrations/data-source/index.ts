import { ConfigurationError, type IntegrationContext } from "@openmapx/core";
import { createDataSourceOrchestrator } from "./orchestrator.js";

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createDataSourceOrchestrator(ctx);

  ctx.registerRoute("GET", "/", async (_req, reply) => {
    const sources = await orchestrator.listWithFilters();
    reply.send({ sources });
  });

  ctx.registerRoute("GET", "/:id/search", async (req, reply) => {
    const provider = orchestrator.getProvider(req.params.id);
    if (!provider) {
      reply.status(404).send({ error: "Unknown data source" });
      return;
    }

    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const north = Number(req.query.north);
    const east = Number(req.query.east);

    if ([south, west, north, east].some((n) => !Number.isFinite(n))) {
      reply.status(400).send({ error: "Invalid bbox coordinates" });
      return;
    }

    const bbox = { south, west, north, east };

    let filters: Record<string, unknown> | undefined;
    if (req.query.filters) {
      try {
        filters = JSON.parse(req.query.filters);
      } catch {
        reply.status(400).send({ error: "Invalid filters JSON" });
        return;
      }
    }

    const searchTtl = orchestrator.getSearchTtl(provider);
    const cacheKey = orchestrator.searchCacheKey(req.params.id, bbox, filters);

    try {
      const results = await ctx.cache.withCache(cacheKey, searchTtl, () =>
        provider.search(bbox, filters),
      );
      reply.header("Cache-Control", `public, max-age=${Math.min(searchTtl, 300)}`);
      reply.send(results);
    } catch (err) {
      if (err instanceof ConfigurationError) {
        reply.status(503).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/:id/detail/*", async (req, reply) => {
    const provider = orchestrator.getProvider(req.params.id);
    if (!provider) {
      reply.status(404).send({ error: "Unknown data source" });
      return;
    }

    const itemId = req.params["*"];
    if (!itemId) {
      reply.status(400).send({ error: "Missing item ID" });
      return;
    }

    const detailTtl = orchestrator.getDetailTtl(provider);
    const cacheKey = orchestrator.detailCacheKey(req.params.id, itemId);

    try {
      const detail = await ctx.cache.withCache(cacheKey, detailTtl, () =>
        provider.getDetail(itemId),
      );
      if (!detail) {
        reply.status(404).send({ error: "Item not found" });
        return;
      }
      reply.header("Cache-Control", `public, max-age=${Math.min(detailTtl, 300)}`);
      reply.send(detail);
    } catch (err) {
      if (err instanceof ConfigurationError) {
        reply.status(503).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
