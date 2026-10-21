import { integrationAdminOperations } from "@openmapx/core/api-contracts";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(integrationAdminOperations, {
  tag: "integration-admin",
  documentOptionalBodies: true,
  validationPhase: "preHandler",
});

/** Domain exceptions can include DB/provider inputs. Keep those out of the wire/log error path. */
export const registerIntegrationAdminRoute: typeof register = (app, operation, handler, options) =>
  register(
    app,
    operation,
    async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch {
        return reply.code(500).send({ error: "Integration administration failed" });
      }
    },
    options,
  );
