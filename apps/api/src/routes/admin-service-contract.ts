import { serviceAdminOperations } from "@openmapx/core/api-contracts";
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
      } catch {
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
