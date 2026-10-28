import { accountAdminOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import { AuthPolicyError, applyAuthPolicy, authPolicyView } from "../account/auth-policy";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerAccountActions } from "./admin-account-actions";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(accountAdminOperations, {
  tag: "account-admin",
  validationPhase: "preHandler",
});
export async function adminAccountsRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request, reply) => {
    request.adminSession = await requireAdmin(request);
    if (getAdminSession(request).user.id === "loopback")
      return reply.code(403).send({ error: "A full administrator account session is required" });
  });
  await registerAccountActions(app);
  const failure = (error: unknown, reply: import("fastify").FastifyReply) => {
    if (error instanceof AuthPolicyError) {
      const status =
        error.code === "AUTH_POLICY_CONFLICT"
          ? 409
          : error.code === "AUTH_POLICY_INVALID"
            ? 400
            : error.code === "AUTH_POLICY_FORBIDDEN"
              ? 403
              : 503;
      return reply.code(status).send({ error: error.code });
    }
    return reply.code(503).send({ error: "AUTH_POLICY_UNAVAILABLE" });
  };
  register(app, "getAdminAuthPolicy", async (_request, reply) => {
    try {
      return await authPolicyView();
    } catch (error) {
      return failure(error, reply);
    }
  });
  register(
    app,
    "applyAdminAuthPolicy",
    async (request, reply) => {
      try {
        const active = await applyAuthPolicy(request.body, getAdminSession(request).user.id);
        return {
          active,
          authPolicyRevision: active.revision,
          activationVersion: 1 as const,
          appliesTo: "new_auth_operations" as const,
        };
      } catch (error) {
        return failure(error, reply);
      }
    },
    { preHandler: [serviceActionLimit.preHandler()] },
  );
}
