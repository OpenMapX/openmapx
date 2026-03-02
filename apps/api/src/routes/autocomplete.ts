import type { FastifyPluginAsync } from "fastify";
import { peliasService } from "../services/pelias.service";

export const autocompleteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string } }>("/autocomplete", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 1 } },
      },
    },
    handler: async (req) => {
      const { q } = req.query;
      return peliasService.autocomplete(q);
    },
  });
};
