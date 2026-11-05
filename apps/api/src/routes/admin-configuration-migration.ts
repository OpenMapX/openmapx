import type { FastifyInstance } from "fastify";
import { configurationMigrationOperations } from "../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import { configurationMigrationInventory } from "../services/configuration-migration/inventory";
import { jobRunner } from "../services/job-runner";
import { createDurableOpsKey } from "../services/ops-client";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";
import { adminReauthNonce } from "./admin-reauthentication";

const register = createAdminRouteRegistrar(configurationMigrationOperations, {
  tag: "integration-admin",
  validationPhase: "preHandler",
});
export async function adminConfigurationMigrationRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST") route.bodyLimit = 1048576;
  });
  const limit = new RateLimiter({
    max: 12,
    windowMs: 60000,
    keyFn: (r) => getAdminSession(r).user.id,
  });
  app.addHook("onClose", async () => limit.destroy());
  register(app, "getAdminConfigurationMigrationInventory", async () =>
    configurationMigrationInventory(),
  );
  register(
    app,
    "exportAdminConfigurationMigration",
    async () => (await configurationMigrationInventory()).document,
  );
  register(
    app,
    "previewAdminConfigurationMigration",
    async (request, reply) => {
      const actor = getAdminSession(request);
      if (actor.user.id === "loopback" || actor.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      try {
        return await jobRunner.runImmediateConfigurationMigrationPreview({
          actorId: actor.user.id,
          operationKey: createDurableOpsKey(
            "migration.preview",
            `${actor.user.id}:${request.headers["idempotency-key"]}`,
          ),
          document: request.body,
        });
      } catch {
        return reply
          .code(503)
          .send({ error: "Migration validation is unavailable; no configuration was applied" });
      }
    },
    { preHandler: limit.preHandler() },
  );
  register(
    app,
    "applyAdminConfigurationMigration",
    async (request, reply) => {
      const actor = getAdminSession(request);
      if (actor.user.id === "loopback" || actor.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      try {
        return await jobRunner.runImmediateConfigurationMigration({
          actorId: actor.user.id,
          operationKey: createDurableOpsKey(
            "migration.apply",
            `${actor.user.id}:${request.headers["idempotency-key"]}`,
          ),
          previewId: request.body.previewId,
          fingerprint: request.body.fingerprint,
          kind: "migration",
          ...(request.body.platformAuthorization
            ? {
                platformAuthorization: {
                  confirmations: request.body.platformAuthorization.confirmations,
                  ...(request.body.platformAuthorization.proofToken
                    ? {
                        proof: {
                          challengeId: request.body.platformAuthorization.proofToken,
                          sessionId: actor.session.id,
                          nonce: adminReauthNonce(request.headers.cookie) ?? Buffer.alloc(0),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        });
      } catch {
        return reply.code(503).send({
          error: "Migration did not settle; inspect Activity before submitting another operation",
        });
      }
    },
    { preHandler: limit.preHandler() },
  );
}
