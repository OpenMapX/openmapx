import type { DataSourceDetail, DataSourceResult } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { ApiKeyMissingError } from "../services/data-sources/ev-charging/ocm.js";
import { dataSourceRegistry } from "../services/data-sources/registry.js";
import { serviceRegistry } from "../services/service-registry.js";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

export const dataSourcesRoute: FastifyPluginAsync = async (fastify) => {
  // List available data sources with filter definitions
  fastify.get("/data-sources", async (_req, reply) => {
    const providers = dataSourceRegistry.getAll().filter((p) => {
      if (!p.serviceIds || p.serviceIds.length === 0) return true;
      return p.serviceIds.some((id) => serviceRegistry.isAvailable(id));
    });
    const sources = await Promise.all(
      providers.map(async (p) => {
        const filters = await withCache(`cache:ds:filters:${p.id}`, TTL.dataSources.filters, () =>
          p.getFilters(),
        );
        return { ...p.meta, filters };
      }),
    );
    return reply.send({ sources });
  });

  // Search within bounding box
  fastify.get<{
    Params: { id: string };
    Querystring: { south: string; west: string; north: string; east: string; filters?: string };
  }>("/data-sources/:id/search", async (req, reply) => {
    const provider = dataSourceRegistry.get(req.params.id);
    if (!provider) return reply.status(404).send({ error: "Unknown data source" });

    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const north = Number(req.query.north);
    const east = Number(req.query.east);

    if ([south, west, north, east].some((n) => !Number.isFinite(n))) {
      return reply.status(400).send({ error: "Invalid bbox coordinates" });
    }

    const bbox = { south, west, north, east };

    let filters: Record<string, unknown> | undefined;
    if (req.query.filters) {
      try {
        filters = JSON.parse(req.query.filters);
      } catch {
        return reply.status(400).send({ error: "Invalid filters JSON" });
      }
    }

    const roundedBbox = `${round(south, 2)},${round(west, 2)},${round(north, 2)},${round(east, 2)}`;
    const filterHash = filters ? hashKey("f", filters) : "none";
    const cacheKey = `cache:ds:search:${req.params.id}:${roundedBbox}:${filterHash}`;

    const searchTtl = provider.searchCacheTtl ?? TTL.dataSources.search;

    let results: DataSourceResult[] = [];
    try {
      results = await withCache(cacheKey, searchTtl, () => provider.search(bbox, filters));
    } catch (err) {
      if (err instanceof ApiKeyMissingError) {
        return reply.status(503).send({ error: err.message });
      }
      throw err;
    }

    reply.header("Cache-Control", `public, max-age=${Math.min(searchTtl, 300)}`);
    return reply.send(results);
  });

  // Get detail for a specific item (wildcard param to support IDs with slashes like "tankerkoenig/uuid")
  fastify.get<{
    Params: { id: string; "*": string };
  }>("/data-sources/:id/detail/*", async (req, reply) => {
    const provider = dataSourceRegistry.get(req.params.id);
    if (!provider) return reply.status(404).send({ error: "Unknown data source" });

    const itemId = req.params["*"];
    if (!itemId) return reply.status(400).send({ error: "Missing item ID" });

    const detailTtl = provider.detailCacheTtl ?? TTL.dataSources.detail;
    const safeItemId = itemId.length > 200 ? hashKey("", itemId) : itemId;
    const cacheKey = `cache:ds:detail:${req.params.id}:${safeItemId}`;
    let detail: DataSourceDetail | null = null;
    try {
      detail = await withCache(cacheKey, detailTtl, () => provider.getDetail(itemId));
    } catch (err) {
      if (err instanceof ApiKeyMissingError) {
        return reply.status(503).send({ error: err.message });
      }
      throw err;
    }

    reply.header("Cache-Control", `public, max-age=${Math.min(detailTtl, 300)}`);
    return reply.send(detail);
  });
};
