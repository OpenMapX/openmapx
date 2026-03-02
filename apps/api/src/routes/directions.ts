import type { FastifyPluginAsync } from "fastify";
import { osrmService } from "../services/osrm.service";
import { valhallaService } from "../services/valhalla.service";

// Phase 5 — OSRM for car, Valhalla for multi-modal
export const directionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      originLng: string;
      originLat: string;
      destLng: string;
      destLat: string;
      mode?: string;
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
        },
      },
    },
    handler: async (req, _reply) => {
      const { originLng, originLat, destLng, destLat, mode = "driving" } = req.query;
      const origin: [number, number] = [Number(originLng), Number(originLat)];
      const destination: [number, number] = [Number(destLng), Number(destLat)];

      if (mode === "driving") {
        return osrmService.route(origin, destination);
      }
      return valhallaService.route(origin, destination, mode as "walking" | "cycling");
    },
  });
};
