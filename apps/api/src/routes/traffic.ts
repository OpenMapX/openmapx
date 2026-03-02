import type { FastifyPluginAsync } from "fastify";

// Phase 6 — TomTom or OpenTrafficCam integration
export const trafficRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/traffic", async () => {
    return { data: [], message: "Not yet implemented — Phase 6" };
  });
};
