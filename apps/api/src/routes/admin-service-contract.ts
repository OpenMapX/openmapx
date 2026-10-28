import { serviceAdminOperations } from "@openmapx/core/api-contracts";
import { ConfigurationPrerequisiteFailure } from "../services/admin-job-failure";
import {
  ConfigurationSourceOwned,
  IntegrationConfigurationConflict,
} from "../services/configuration-ownership-view";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(serviceAdminOperations, {
  tag: "service-admin",
  documentOptionalBodies: true,
  validationPhase: "preHandler",
});

/** Domain errors may contain host/configuration inputs; never expose those. */
export const registerServiceAdminRoute: typeof register = (app, operation, handler, options) =>
  register(
    app,
    operation,
    async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof IntegrationConfigurationConflict)
          return reply.code(409).send({ code: error.code, error: error.message });
        if (error instanceof ConfigurationSourceOwned)
          return reply
            .code(409)
            .send({ code: error.code, error: error.message, ownership: error.ownership });
        if (error instanceof ConfigurationPrerequisiteFailure)
          return reply.code(409).send({ error: error.message });
        return reply.code(500).send({ error: "Service administration failed" });
      }
    },
    {
      ...options,
      beforeValidation: options?.beforeValidation
        ? async (request, reply) => {
            try {
              return await options.beforeValidation?.(request, reply);
            } catch {
              return reply.code(500).send({ error: "Service administration failed" });
            }
          }
        : undefined,
    },
  );
