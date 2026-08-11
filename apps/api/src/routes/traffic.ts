import type { FastifyPluginAsync } from "fastify";
import { getTrafficProvider } from "../services/traffic.factory";
import { TrafficProviderHttpError } from "../services/traffic.provider";
import { declareRouteAuth } from "../utils/route-auth";

export const trafficRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/traffic/flow/:z/:x/:y.png", {
    schema: {
      params: {
        type: "object",
        required: ["z", "x", "y"],
        properties: {
          z: { type: "string", pattern: "^[0-9]{1,2}$" },
          x: { type: "string", pattern: "^[0-9]+$" },
          y: { type: "string", pattern: "^[0-9]+$" },
        },
      },
    },
    handler: async (req, reply) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);

      if (![z, x, y].every((v) => Number.isFinite(v) && v >= 0)) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }

      try {
        const tile = await getTrafficProvider().getFlowTile(z, x, y);

        reply.header("Cache-Control", tile.cacheControl ?? "public, max-age=30, s-maxage=30");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type(tile.contentType);
        return reply.send(Buffer.from(tile.bytes));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Traffic tile request failed";
        req.log.warn({ err: error, z, x, y }, "Traffic tile request failed");

        if (message.includes("TOMTOM_TRAFFIC_KEY")) {
          return reply
            .status(503)
            .send({ message: "Traffic tiles are not configured on the API server" });
        }

        if (error instanceof TrafficProviderHttpError) {
          const statusCode =
            error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
          return reply.status(statusCode).send({ message: error.message });
        }

        return reply.status(502).send({ message: "Traffic tile provider unavailable" });
      }
    },
  });
};
