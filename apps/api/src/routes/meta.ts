import { registry } from "@integrations/transit-dynamic-registry/registry";
import { listIdSchemeViews } from "@openmapx/place-ids";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../utils/require-auth.js";

/**
 * Small process-level endpoints that belong to no feature area: the health
 * probe Docker and Traefik poll, and two registry dumps used for debugging.
 *
 * They live in a plugin rather than inline on the server instance so that every
 * route the API serves is reachable through `registerCoreRoutes` — the OpenAPI
 * generator mounts that same function, and a route registered directly on the
 * server object would be invisible to it.
 */
export const metaRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", { config: { auth: "public" } }, async () => ({ status: "ok" }));

  // Returns every registered id-scheme view. Replaces the value a static
  // `PLACE_ID_SCHEMES` constant used to carry; reflects what integrations
  // actually registered at boot.
  fastify.get("/api/id-schemes", { config: { auth: "public" } }, async () =>
    listIdSchemeViews().map(({ buildUrl, ...view }) => ({
      ...view,
      linkable: typeof buildUrl === "function",
    })),
  );

  // Lists the loaded dynamic transit providers.
  fastify.get("/api/transit/registry", { config: { auth: "session" } }, async (req) => {
    await requireAuth(req);
    return { entries: registry.listEntries(), count: registry.entryCount };
  });
};
