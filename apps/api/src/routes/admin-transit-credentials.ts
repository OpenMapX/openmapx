import { transitCredentialOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import { AdminReauthenticationError } from "../account/admin-reauthentication";
import { JobObservationPending } from "../services/admin-job-failure";
import { jobRunner } from "../services/job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client";
import { bindTransitCredentialAuthorization } from "../services/transit-credential-authorization";
import { TransitCredentialConflict } from "../services/transit-credential-preview";
import {
  inspectFeedCredentials,
  previewFeedCredentialChanges,
} from "../services/transit-feed-credentials";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";
import { adminReauthNonce } from "./admin-reauthentication";

const register = createAdminRouteRegistrar(transitCredentialOperations, {
  tag: "data-manager-admin",
  validationPhase: "preHandler",
});
export async function adminTransitCredentialsRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST" || route.method === "PATCH") route.bodyLimit = 1024 * 1024;
  });
  const limits = new RateLimiter({
    max: 12,
    windowMs: 60_000,
    keyFn: (request) => getAdminSession(request).user.id,
  });
  app.addHook("onClose", async () => limits.destroy());
  const failure = (error: unknown) => ({
    status:
      error instanceof TransitCredentialConflict || error instanceof AdminReauthenticationError
        ? 409
        : 503,
    error:
      error instanceof TransitCredentialConflict || error instanceof AdminReauthenticationError
        ? error.code
        : error instanceof JobObservationPending
          ? "Credential application is pending reconciliation; inspect Activity before retrying"
          : "Transit credential administration is unavailable",
  });
  register(app, "getAdminTransitCredentials", async (_request, reply) => {
    try {
      const pair = await executeAndWait(
        createApiOpsClient(),
        { kind: "catalogPins.inspect" },
        createDurableOpsKey("transit.credentials.current", "current"),
      );
      if (!pair.catalogRevisionId)
        return reply
          .code(503)
          .send({ error: "Select and activate catalog pins before managing feed credentials" });
      return await inspectFeedCredentials({ catalogRevisionId: pair.catalogRevisionId });
    } catch (error) {
      const result = failure(error);
      return reply.code(result.status).send({ error: result.error });
    }
  });
  register(
    app,
    "previewAdminTransitCredentials",
    async (request, reply) => {
      const actor = getAdminSession(request);
      if (actor.user.id === "loopback" || actor.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      try {
        return await previewFeedCredentialChanges({ ...request.body, actorId: actor.user.id });
      } catch (error) {
        const result = failure(error);
        return reply.code(result.status).send({ error: result.error });
      }
    },
    { preHandler: limits.preHandler() },
  );
  register(
    app,
    "applyAdminTransitCredentials",
    async (request, reply) => {
      const actor = getAdminSession(request),
        nonce = adminReauthNonce(request.headers.cookie);
      if (actor.user.id === "loopback" || actor.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      if (!nonce) return reply.code(409).send({ error: "REAUTHENTICATION_FAILED" });
      try {
        await bindTransitCredentialAuthorization({
          ...request.body,
          actorId: actor.user.id,
          sessionId: actor.session.id,
          nonce: nonce.toString("base64url"),
        });
        return await jobRunner.applyImmediateTransitCredentials({
          ...request.body,
          actorId: actor.user.id,
        });
      } catch (error) {
        const result = failure(error);
        return reply.code(result.status).send({ error: result.error });
      }
    },
    { preHandler: limits.preHandler() },
  );
}
