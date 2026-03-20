import type { FastifyPluginAsync } from "fastify";
import { osrmService } from "../services/osrm.service.js";
import { valhallaService } from "../services/valhalla.service.js";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

export const directionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      originLng: string;
      originLat: string;
      destLng: string;
      destLat: string;
      mode?: string;
      avoidHighways?: string;
      avoidTolls?: string;
      avoidFerries?: string;
      units?: string;
      lang?: string;
    };
  }>("/directions", {
    schema: {
      querystring: {
        type: "object",
        required: ["originLng", "originLat", "destLng", "destLat"],
        properties: {
          originLng: { type: "string" },
          originLat: { type: "string" },
          destLng: { type: "string" },
          destLat: { type: "string" },
          mode: { type: "string", enum: ["driving", "walking", "cycling", "transit"] },
          avoidHighways: { type: "string" },
          avoidTolls: { type: "string" },
          avoidFerries: { type: "string" },
          units: { type: "string", enum: ["metric", "imperial"] },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const {
        originLng,
        originLat,
        destLng,
        destLat,
        mode = "driving",
        avoidHighways,
        avoidTolls,
        avoidFerries,
        units,
        lang,
      } = req.query;

      const origin: [number, number] = [Number(originLng), Number(originLat)];
      const destination: [number, number] = [Number(destLng), Number(destLat)];
      const opts = {
        avoidHighways: avoidHighways === "true",
        avoidTolls: avoidTolls === "true",
        avoidFerries: avoidFerries === "true",
        units: (units ?? "metric") as "metric" | "imperial",
      };

      if (mode === "transit") {
        return reply.status(400).send({ error: "Use /api/transit/plan for transit routing" });
      }

      // Keys in alphabetical order — JSON.stringify preserves insertion order in V8,
      // producing a stable, deterministic cache key regardless of query param order.
      const keyParams = {
        avoidFerries: opts.avoidFerries,
        avoidHighways: opts.avoidHighways,
        avoidTolls: opts.avoidTolls,
        destLat: round(Number(destLat), 4),
        destLng: round(Number(destLng), 4),
        lang: lang ?? "en",
        mode,
        originLat: round(Number(originLat), 4),
        originLng: round(Number(originLng), 4),
        units: opts.units,
      };

      const result = await withCache(hashKey("cache:directions", keyParams), TTL.directions, () => {
        if (mode === "driving") {
          return osrmService.route(origin, destination, opts);
        }
        return valhallaService.route(
          origin,
          destination,
          mode as "walking" | "cycling",
          opts,
          lang,
        );
      });
      reply.header("Cache-Control", "public, max-age=3600");
      return result;
    },
  });
};
