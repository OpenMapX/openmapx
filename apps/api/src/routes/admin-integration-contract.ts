import { integrationAdminOperations } from "@openmapx/core/api-contracts";
import { ConfigurationPrerequisiteFailure } from "../services/admin-job-failure";
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
      } catch (error) {
        if (error instanceof ConfigurationPrerequisiteFailure)
          return reply.code(409).send({ error: error.message });
        return reply.code(500).send({ error: "Integration administration failed" });
      }
    },
    options,
  );
