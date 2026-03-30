import { OverpassRateLimitError } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { fetchWinterSportsFeatures } from "../services/winter-sports/overpass";
import { round, TTL, withCacheStatus } from "../utils/cache.js";

const MAX_BBOX_SPAN = 0.5;

export const winterSportsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { south: string; west: string; north: string; east: string };
  }>("/winter-sports/features", {
    schema: {
      querystring: {
        type: "object",
        required: ["south", "west", "north", "east"],
        properties: {
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const south = Number(req.query.south);
      const west = Number(req.query.west);
      const north = Number(req.query.north);
      const east = Number(req.query.east);

      if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
        return reply.status(400).send({ message: "Invalid bbox coordinates" });
      }

      if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
        return reply.status(400).send({
          message: `Bbox too large (max ${MAX_BBOX_SPAN} degree span)`,
        });
      }

      const rs = round(south, 2);
      const rw = round(west, 2);
      const rn = round(north, 2);
      const re = round(east, 2);
      const cacheKey = `cache:winter-sports:features:${rs},${rw},${rn},${re}`;

      try {
        const { data, status } = await withCacheStatus(cacheKey, TTL.winterSports, () =>
          fetchWinterSportsFeatures(rs, rw, rn, re),
        );

        reply.header("Cache-Control", "public, max-age=3600");
        reply.header("X-Cache", status);
        return data;
      } catch (error) {
        if (error instanceof OverpassRateLimitError) {
          return reply.status(429).send({ message: "Overpass rate limit exceeded" });
        }
        req.log.warn({ err: error }, "Winter sports feature fetch failed");
        return reply.status(502).send({ message: "Winter sports data unavailable" });
      }
    },
  });
};
