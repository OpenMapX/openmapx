import type { FastifyPluginAsync } from "fastify";

export const airQualityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/air-quality/tiles/:z/:x/:y.png", {
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
      const token = process.env.WAQI_TOKEN;
      if (!token) {
        return reply.status(503).send({ message: "Air quality tiles are not configured" });
      }

      const { z, x, y } = req.params;
      const url = `https://tiles.aqicn.org/tiles/usepa-aqi/${z}/${x}/${y}.png?token=${token}`;

      const upstream = await fetch(url);
      if (!upstream.ok) {
        req.log.warn({ z, x, y, status: upstream.status }, "WAQI tile request failed");
        return reply.status(upstream.status).send({ message: "Air quality tile unavailable" });
      }

      const bytes = await upstream.arrayBuffer();
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      reply.type("image/png");
      return reply.send(Buffer.from(bytes));
    },
  });
};
