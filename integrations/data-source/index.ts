import { ConfigurationError } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
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
      const envelope = await ctx.cache.withCache(cacheKey, searchTtl, () =>
        provider.search(bbox, filters),
      );
      reply.header("Cache-Control", `public, max-age=${Math.min(searchTtl, 300)}`);
      reply.send({
        data: envelope.data,
        attributions: envelope.attributions,
        freshness: envelope.freshness,
      });
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
      const envelope = await ctx.cache.withCache(cacheKey, detailTtl, () =>
        provider.getDetail(itemId),
      );
      if (!envelope.data) {
        reply.status(404).send({ error: "Item not found" });
        return;
      }
      reply.header("Cache-Control", `public, max-age=${Math.min(detailTtl, 300)}`);
      // Stamp the producing provider id so the client resolves this detail's
      // I18nTokens against the right integration catalog. Done on the way out
      // (not inside the cached producer) so cached entries are stamped too.
      reply.send({
        data: { ...envelope.data, providerId: provider.id },
        attributions: envelope.attributions,
        freshness: envelope.freshness,
      });
    } catch (err) {
      if (err instanceof ConfigurationError) {
        reply.status(503).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/:id/map-context", async (req, reply) => {
    const provider = orchestrator.getProvider(req.params.id);
    if (!provider) {
      reply.status(404).send({ error: "Unknown data source" });
      return;
    }

    const getMapContext = provider.getMapContext;
    if (!getMapContext) {
      reply.send({
        data: null,
        attributions: [],
        freshness: {
          fetchedAt: new Date().toISOString(),
          hasRealtimeData: false,
          isStale: false,
        },
      });
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

    let options: Record<string, unknown> | undefined;
    if (req.query.options) {
      try {
        options = JSON.parse(req.query.options);
      } catch {
        reply.status(400).send({ error: "Invalid options JSON" });
        return;
      }
    }

    const ttl = orchestrator.getMapContextTtl(provider);
    const cacheKey = orchestrator.mapContextCacheKey(req.params.id, bbox, filters, options);

    try {
      const envelope = await ctx.cache.withCache(cacheKey, ttl, () =>
        getMapContext(bbox, filters, options),
      );
      reply.header("Cache-Control", `public, max-age=${Math.min(ttl, 300)}`);
      reply.send({
        data: envelope.data ?? null,
        attributions: envelope.attributions,
        freshness: envelope.freshness,
      });
    } catch (err) {
      if (err instanceof ConfigurationError) {
        reply.status(503).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
