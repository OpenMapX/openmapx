import type { FastifyPluginAsync } from "fastify";

// Phase 4 — will query PostGIS for POI data
export const placesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/places", async () => {
    return { data: [], message: "Not yet implemented — Phase 4" };
  });

  fastify.get<{ Params: { id: string } }>("/places/:id", async (req) => {
    return { id: req.params.id, message: "Not yet implemented — Phase 4" };
  });
};
