import type { FastifyPluginAsync } from "fastify";
import { osrmService } from "../services/osrm.service.js";
import { valhallaService } from "../services/valhalla.service.js";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

/** Parse semicolon-separated "lng,lat" pairs into coordinate tuples. */
function parseWaypoints(raw: string): [number, number][] {
  return raw.split(";").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number);
    return [lng, lat] as [number, number];
  });
}

/** Round all waypoints for cache-key stability. */
function roundWaypoints(wps: [number, number][]): [number, number][] {
  return wps.map((wp) => [round(wp[0], 4), round(wp[1], 4)]);
}

export const directionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      waypoints?: string;
      originLng?: string;
      originLat?: string;
      destLng?: string;
      destLat?: string;
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
        properties: {
          waypoints: { type: "string" },
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
        waypoints: waypointsParam,
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

      let waypoints: [number, number][];

      if (waypointsParam) {
        waypoints = parseWaypoints(waypointsParam);
      } else if (originLng && originLat && destLng && destLat) {
        // Legacy 2-point format
        waypoints = [
          [Number(originLng), Number(originLat)],
          [Number(destLng), Number(destLat)],
        ];
      } else {
        return reply.status(400).send({
          error:
            "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
        });
      }

      if (waypoints.length < 2) {
        return reply.status(400).send({ error: "At least 2 waypoints are required" });
      }

      const opts = {
        avoidHighways: avoidHighways === "true",
        avoidTolls: avoidTolls === "true",
        avoidFerries: avoidFerries === "true",
        units: (units ?? "metric") as "metric" | "imperial",
      };

      if (mode === "transit") {
        return reply.status(400).send({ error: "Use /api/transit/plan for transit routing" });
      }

      const keyParams = {
        avoidFerries: opts.avoidFerries,
        avoidHighways: opts.avoidHighways,
        avoidTolls: opts.avoidTolls,
        lang: lang ?? "en",
        mode,
        units: opts.units,
        waypoints: roundWaypoints(waypoints),
      };

      const result = await withCache(hashKey("cache:directions", keyParams), TTL.directions, () => {
        if (mode === "driving") {
          return osrmService.route(waypoints, opts);
        }
        return valhallaService.route(waypoints, mode as "walking" | "cycling", opts, lang);
      });
      reply.header("Cache-Control", "public, max-age=3600");
      return result;
    },
  });

  fastify.get<{
    Querystring: {
      waypoints?: string;
      originLng?: string;
      originLat?: string;
      destLng?: string;
      destLat?: string;
      mode?: string;
      avoidHighways?: string;
      avoidTolls?: string;
      avoidFerries?: string;
      units?: string;
      lang?: string;
    };
  }>("/directions/optimize", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          waypoints: { type: "string" },
          originLng: { type: "string" },
          originLat: { type: "string" },
          destLng: { type: "string" },
          destLat: { type: "string" },
          mode: { type: "string", enum: ["driving", "walking", "cycling"] },
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
        waypoints: waypointsParam,
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

      let waypoints: [number, number][];

      if (waypointsParam) {
        waypoints = parseWaypoints(waypointsParam);
      } else if (originLng && originLat && destLng && destLat) {
        waypoints = [
          [Number(originLng), Number(originLat)],
          [Number(destLng), Number(destLat)],
        ];
      } else {
        return reply.status(400).send({
          error:
            "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
        });
      }

      if (waypoints.length < 3) {
        return reply
          .status(400)
          .send({ error: "At least 3 waypoints are required for optimization" });
      }

      const opts = {
        avoidHighways: avoidHighways === "true",
        avoidTolls: avoidTolls === "true",
        avoidFerries: avoidFerries === "true",
        units: (units ?? "metric") as "metric" | "imperial",
      };

      const keyParams = {
        avoidFerries: opts.avoidFerries,
        avoidHighways: opts.avoidHighways,
        avoidTolls: opts.avoidTolls,
        lang: lang ?? "en",
        mode,
        optimize: true,
        units: opts.units,
        waypoints: roundWaypoints(waypoints),
      };

      const result = await withCache(
        hashKey("cache:directions:optimize", keyParams),
        TTL.directions,
        async () => {
          try {
            return await osrmService.optimizeRoute(waypoints, opts);
          } catch {
            return valhallaService.optimizeRoute(
              waypoints,
              mode as "driving" | "walking" | "cycling",
              opts,
              lang,
            );
          }
        },
      );
      reply.header("Cache-Control", "public, max-age=3600");
      return result;
    },
  });
};
