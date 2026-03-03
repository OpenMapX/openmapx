import type { FastifyPluginAsync } from "fastify";
import { osrmService } from "../services/osrm.service.js";
import { valhallaService } from "../services/valhalla.service.js";

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
        },
      },
    },
    handler: async (req, _reply) => {
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
      } = req.query;

      const origin: [number, number] = [Number(originLng), Number(originLat)];
      const destination: [number, number] = [Number(destLng), Number(destLat)];
      const opts = {
        avoidHighways: avoidHighways === "true",
        avoidTolls: avoidTolls === "true",
        avoidFerries: avoidFerries === "true",
        units: (units ?? "metric") as "metric" | "imperial",
      };

      if (mode === "driving") {
        return osrmService.route(origin, destination, opts);
      }
      return valhallaService.route(origin, destination, mode as "walking" | "cycling", opts);
    },
  });
};
