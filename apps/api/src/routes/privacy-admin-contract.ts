import { privacyAdminOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(privacyAdminOperations, {
  tag: "privacy-admin",
  validationPhase: "preHandler",
});
/** The guarded parent owns real-session privacy authorization before parsing. */
export function registerPrivacyAdminRoute<T extends RouteGenericInterface>(
  app: FastifyInstance,
  operation: keyof typeof privacyAdminOperations,
  handler: (request: FastifyRequest<T>, reply: FastifyReply) => unknown,
) {
  register(app, operation, handler as never);
}
