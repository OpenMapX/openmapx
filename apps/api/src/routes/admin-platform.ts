import type { FastifyInstance } from "fastify";
import { AdminReauthenticationError } from "../account/admin-reauthentication";
import {
  createDirectAdminOpsKey,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import {
  inspectPlatformConfiguration,
  previewPlatformConfiguration,
} from "../services/platform-configuration-view";
import { PlatformPreviewConflict } from "../services/platform-preview-store";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

export async function adminPlatformRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  const limits = new RateLimiter({
    max: 12,
    windowMs: 60000,
    keyFn: (req) => getAdminSession(req).user.id,
  });
  app.addHook("onClose", async () => limits.destroy());
  const failure = (error: unknown) =>
    error instanceof PlatformPreviewConflict || error instanceof AdminReauthenticationError
      ? {
          status: 409,
          error: "Platform preview, source or authorization changed; create a new preview",
        }
      : {
          status: 503,
          error:
            "Platform configuration is unavailable; inspect Activity and host recovery guidance",
        };
  registerServiceAdminRoute(app, "getAdminPlatformConfiguration", async (_request, reply) => {
    try {
      return await inspectPlatformConfiguration();
    } catch (error) {
      const value = failure(error);
      return reply.code(value.status).send({ error: value.error });
    }
  });
  registerServiceAdminRoute(
    app,
    "previewAdminPlatformConfiguration",
    async (request, reply) => {
      const actor = getAdminSession(request);
      if (actor.user.id === "loopback" || actor.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      try {
        return await previewPlatformConfiguration({
          ...request.body,
          actorId: actor.user.id,
          operationKey: createDirectAdminOpsKey(
            actor.user.id,
            parseDirectOpsIdempotency(request.headers["idempotency-key"]),
          ),
        });
      } catch (error) {
        const value = failure(error);
        return reply.code(value.status).send({ error: value.error });
      }
    },
    { preHandler: limits.preHandler() },
  );
}
