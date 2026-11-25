import type { FastifyPluginAsync } from "fastify";
import { getAttributionIndex } from "../services/attribution";
import { declareRouteAuth } from "../utils/route-auth";

const CACHE_HEADER = "public, max-age=86400, must-revalidate";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parsePagination(query: Record<string, string | string[] | undefined>): {
  limit: number;
  offset: number;
} {
  const rawLimit = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  const rawOffset = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  const parsedLimit = Number(rawLimit ?? DEFAULT_LIMIT);
  const parsedOffset = Number(rawOffset ?? 0);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(parsedOffset) ? Math.max(Math.trunc(parsedOffset), 0) : 0;
  return { limit, offset };
}

/**
 * Read-only public attribution resolver. Backed by the singleton
 * `AttributionIndex` initialised in `initIntegrations`. Returns 503 when the
 * index hasn't been initialised — the index is created during host startup,
 * so a 503 indicates a misconfigured boot, not a transient outage.
 */
const INDEX_UNAVAILABLE = {
  error: "Attribution index unavailable",
  code: "ATTRIBUTION_INDEX_UNAVAILABLE",
} as const;
const NOT_FOUND = { error: "Attribution not found", code: "NOT_FOUND" } as const;

export const attributionRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get("/attribution/health", async (_req, reply) => {
    const idx = getAttributionIndex();
    if (!idx) {
      return reply.status(503).send(INDEX_UNAVAILABLE);
    }
    reply.header("Cache-Control", CACHE_HEADER);
    return reply.send(idx.health());
  });

  fastify.get<{ Querystring: Record<string, string | string[]> }>(
    "/attribution",
    async (req, reply) => {
      const idx = getAttributionIndex();
      if (!idx) {
        return reply.status(503).send(INDEX_UNAVAILABLE);
      }
      const { limit, offset } = parsePagination(req.query);
      const all = idx.list();
      const page = all.slice(offset, offset + limit);
      reply.header("Cache-Control", CACHE_HEADER);
      return reply.send({
        items: page,
        total: all.length,
        limit,
        offset,
      });
    },
  );

  fastify.get<{ Params: { filename: string } }>(
    "/attribution/motis-file/:filename",
    async (req, reply) => {
      const idx = getAttributionIndex();
      if (!idx) {
        return reply.status(503).send(INDEX_UNAVAILABLE);
      }
      const attr = idx.getForMotisFile(req.params.filename);
      if (!attr) {
        return reply.status(404).send(NOT_FOUND);
      }
      reply.header("Cache-Control", CACHE_HEADER);
      return reply.send(attr);
    },
  );

  fastify.get<{ Params: { sourceId: string } }>("/attribution/:sourceId", async (req, reply) => {
    const idx = getAttributionIndex();
    if (!idx) {
      return reply.status(503).send(INDEX_UNAVAILABLE);
    }
    const attr = idx.getById(req.params.sourceId);
    if (!attr) {
      return reply.status(404).send(NOT_FOUND);
    }
    reply.header("Cache-Control", CACHE_HEADER);
    return reply.send(attr);
  });
};
