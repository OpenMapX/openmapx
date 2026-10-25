import type { FastifyPluginAsync } from "fastify";
import { getTrafficProvider } from "../services/traffic.factory";
import { TrafficProviderHttpError } from "../services/traffic.provider";
import { bindRequestAbort } from "../utils/request-abort.js";
import { declareRouteAuth } from "../utils/route-auth";
import { parseWebMercatorTileCoordinates } from "../utils/tile-coordinates.js";
import { normalizeUpstreamResponseStream } from "../utils/upstream-response.js";

const TOMTOM_TRAFFIC_MAX_ZOOM = 22;

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
      const coords = parseWebMercatorTileCoordinates(
        req.params.z,
        req.params.x,
        req.params.y,
        TOMTOM_TRAFFIC_MAX_ZOOM,
      );
      if (!coords) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }
      const { z, x, y } = coords;
      reply.header("Cache-Control", "no-store");
      const requestAbort = bindRequestAbort(req, reply);

      try {
        const tile = await getTrafficProvider().getFlowTile(z, x, y, requestAbort.signal);

        reply.header("Cache-Control", tile.cacheControl ?? "public, max-age=30, s-maxage=30");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type(tile.contentType);
        return reply.send(
          normalizeUpstreamResponseStream(
            tile.body,
            "Traffic tile provider returned an invalid response",
          ),
        );
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
