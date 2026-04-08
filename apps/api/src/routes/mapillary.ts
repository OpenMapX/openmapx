import type { FastifyPluginAsync } from "fastify";

export const mapillaryRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/mapillary/tiles/:z/:x/:y", {
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
      const token = process.env.MAPILLARY_TOKEN;
      if (!token) {
        return reply.status(503).send({ message: "Mapillary tiles are not configured" });
      }

      const { z, x, y } = req.params;
      const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${z}/${x}/${y}?access_token=${token}`;

      const upstream = await fetch(url);
      if (!upstream.ok) {
        req.log.warn({ z, x, y, status: upstream.status }, "Mapillary tile request failed");
        return reply.status(upstream.status).send({ message: "Mapillary tile unavailable" });
      }

      const bytes = await upstream.arrayBuffer();
      // Mapillary serves vector tiles as MVT; forward the upstream content-type
      const contentType =
        upstream.headers.get("content-type") ?? "application/vnd.mapbox-vector-tile";
      reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.type(contentType);
      return reply.send(Buffer.from(bytes));
    },
  });
};
