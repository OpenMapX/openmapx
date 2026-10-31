import { integrationAdminOperations } from "@openmapx/core/api-contracts";
import {
  ConfigurationPrerequisiteFailure,
  JobObservationPending,
} from "../services/admin-job-failure";
import {
  ConfigurationSourceOwned,
  IntegrationConfigurationConflict,
} from "../services/configuration-ownership-view";
import { TrustedConfigurationApplyError } from "../services/trusted-config-outcome";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(integrationAdminOperations, {
  tag: "integration-admin",
  documentOptionalBodies: true,
  validationPhase: "preHandler",
});

/**
 * Domain exceptions can include DB/provider inputs. Keep those out of the
 * wire/log error path, except a configuration apply the operator can fix (a
 * service-file override render may not use), whose reason names files only.
 */
export const registerIntegrationAdminRoute: typeof register = (app, operation, handler, options) =>
  register(
    app,
    operation,
    async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (
          error instanceof JobObservationPending &&
          (operation === "setAdminIntegrationCredential" ||
            operation === "deleteAdminIntegrationCredential")
        )
          return reply.code(503).send({
            error:
              "Credential saved or awaiting reconciliation; inspect its operation status before retrying",
          });
        if (error instanceof IntegrationConfigurationConflict)
          return reply.code(409).send({ code: error.code, error: error.message });
        if (error instanceof ConfigurationSourceOwned)
          return reply
            .code(409)
            .send({ code: error.code, error: error.message, ownership: error.ownership });
        if (error instanceof ConfigurationPrerequisiteFailure)
          return reply.code(409).send({ error: error.message });
        if (error instanceof TrustedConfigurationApplyError && error.statusCode === 409) {
          return reply.code(409).send({ error: error.message });
        }
        return reply.code(500).send({ error: "Integration administration failed" });
      }
    },
    options,
  );
