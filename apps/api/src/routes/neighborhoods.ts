import { OverpassRateLimitError, OverpassTimeoutError } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { fetchNeighborhoods } from "../services/neighborhoods/index.js";
import { round, TTL, withCacheStatus } from "../utils/cache.js";

/**
 * City bboxes can be large; cap the span so we never hand Overpass an
 * unbounded region (which would time out anyway).
 */
const MAX_BBOX_SPAN = 1.5;

export const neighborhoodsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { south: string; west: string; north: string; east: string; lang?: string };
  }>("/neighborhoods", {
    schema: {
      querystring: {
        type: "object",
        required: ["south", "west", "north", "east"],
        properties: {
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const south = Number(req.query.south);
      const west = Number(req.query.west);
      const north = Number(req.query.north);
      const east = Number(req.query.east);
      const lang = req.query.lang;

      if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
        return reply.status(400).send({ message: "Invalid bbox coordinates" });
      }
      if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
        // Too coarse to be a city — return nothing so the section self-hides.
        return { neighborhoods: [] };
      }

      const rs = round(south, 2);
      const rw = round(west, 2);
      const rn = round(north, 2);
      const re = round(east, 2);
      const cacheKey = `cache:neighborhoods:${rs},${rw},${rn},${re}:${lang ?? "en"}`;

      try {
        const { data, status } = await withCacheStatus(cacheKey, TTL.winterSports, () =>
          fetchNeighborhoods(rs, rw, rn, re, lang),
        );
        reply.header("Cache-Control", "public, max-age=86400");
        reply.header("X-Cache", status);
        return data;
      } catch (error) {
        // Overpass hiccups shouldn't surface as a panel error — degrade to empty.
        if (error instanceof OverpassRateLimitError || error instanceof OverpassTimeoutError) {
          return { neighborhoods: [] };
        }
        req.log.warn({ err: error }, "Neighborhoods fetch failed");
        return { neighborhoods: [] };
      }
    },
  });
};
