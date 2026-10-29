import { serviceAdminOperations } from "@openmapx/core/api-contracts";
import { TrustedConfigurationApplyError } from "../services/trusted-config-outcome";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(serviceAdminOperations, {
  tag: "service-admin",
  documentOptionalBodies: true,
  validationPhase: "preHandler",
});

/**
 * Domain errors may contain host/configuration inputs; never expose those.
 * The exception is a configuration apply the operator can fix (an override
 * render may not use), whose reason names files only.
 */
export const registerServiceAdminRoute: typeof register = (app, operation, handler, options) =>
  register(
    app,
    operation,
    async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof TrustedConfigurationApplyError && error.statusCode === 409) {
          return reply.code(409).send({ error: error.message });
        }
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
