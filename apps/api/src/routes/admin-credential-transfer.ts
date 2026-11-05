import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CREDENTIAL_TRANSFER_PREVIEW_INTENT,
  credentialTransferOperations,
} from "../../../../packages/core/src/api/contracts/integration-admin/credential-transfer";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import { db } from "../db";
import { adminAuditLog } from "../db/schema";
import {
  chooseCredentialTransferFields,
  exportCredentialSelection,
  previewCredentialTransfer,
} from "../services/configuration-migration/credential-preview";
import { pruneMigrationStages } from "../services/configuration-migration/staging";
import { jobRunner } from "../services/job-runner";
import { createDurableOpsKey } from "../services/ops-client";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";
import { adminReauthNonce } from "./admin-reauthentication";

const register = createAdminRouteRegistrar(credentialTransferOperations, {
  tag: "integration-admin",
  validationPhase: "preHandler",
});
export async function adminCredentialTransferRoute(app: FastifyInstance) {
  const cleanup = setInterval(() => {
    void pruneMigrationStages().catch(() => {});
  }, 60000);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request, reply) => {
    request.adminSession = await requireAdmin(request);
    const actor = getAdminSession(request);
    if (actor.user.id === "loopback" || actor.session.impersonatedBy)
      return reply.code(403).send({ error: "A real full administrator session is required" });
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST") route.bodyLimit = 1048576 + 8192;
  });
  const limit = new RateLimiter({
    max: 6,
    windowMs: 60000,
    keyFn: (r) => getAdminSession(r).user.id,
  });
  app.addHook("onClose", async () => limit.destroy());
  register(
    app,
    "exportAdminCredentialTransfer",
    async (request, reply) => {
      const actor = getAdminSession(request),
        nonce = adminReauthNonce(request.headers.cookie),
        challengeId = request.headers["x-admin-reauth-proof"] as string | undefined;
      if (!nonce || !challengeId)
        return reply.code(409).send({ error: "Purpose-bound reauthentication is required" });
      try {
        await db.transaction((tx) =>
          new AdminActionReauthentication(tx).consume(
            {
              challengeId,
              purpose: "credentials.export",
              targetId: "vault-transfer",
              sessionId: actor.session.id,
              nonce,
            },
            tx,
          ),
        );
        const envelope = await exportCredentialSelection({
          ...request.body,
          actorId: actor.user.id,
        });
        await db.insert(adminAuditLog).values({
          id: randomUUID(),
          action: "credentials.export",
          actorId: actor.user.id,
          targetType: "credential-transfer",
          targetId: "vault-transfer",
          details: { selection: request.body.selection },
        });
        return envelope;
      } catch {
        return reply.code(503).send({
          error: "Credential export is unavailable; a retry requires fresh reauthentication",
        });
      }
    },
    { preHandler: limit.preHandler() },
  );
  register(
    app,
    "previewAdminCredentialTransfer",
    async (request, reply) => {
      const actor = getAdminSession(request),
        nonce = adminReauthNonce(request.headers.cookie),
        challengeId = request.headers["x-admin-reauth-proof"] as string | undefined;
      if (!nonce || !challengeId)
        return reply.code(409).send({ error: "Purpose-bound reauthentication is required" });
      try {
        await db.transaction((tx) =>
          new AdminActionReauthentication(tx).consume(
            {
              challengeId,
              purpose: "credentials.import",
              intentFingerprint: CREDENTIAL_TRANSFER_PREVIEW_INTENT,
              targetId: "vault-transfer",
              sessionId: actor.session.id,
              nonce,
            },
            tx,
          ),
        );
        const preview = await previewCredentialTransfer({
          ...request.body,
          actorId: actor.user.id,
        });
        await db.insert(adminAuditLog).values({
          id: randomUUID(),
          action: "credentials.import.preview",
          actorId: actor.user.id,
          targetType: "credential-transfer",
          targetId: preview.previewId,
          details: {
            entries: preview.entries.map(({ scope, id, key, status }) => ({
              scope,
              id,
              key,
              status,
            })),
          },
        });
        return preview;
      } catch {
        return reply
          .code(503)
          .send({ error: "Credential envelope or destination is invalid or unavailable" });
      }
    },
    { preHandler: limit.preHandler() },
  );
  register(
    app,
    "chooseAdminCredentialTransferFields",
    async (request, reply) => {
      try {
        return await chooseCredentialTransferFields({
          actorId: getAdminSession(request).user.id,
          previewId: request.params.previewId,
          fingerprint: request.body.expectedIntentFingerprint,
          choices: request.body.choices,
        });
      } catch {
        return reply
          .code(409)
          .send({ error: "Credential choices changed; create a fresh preview" });
      }
    },
    { preHandler: limit.preHandler() },
  );
  register(
    app,
    "applyAdminCredentialTransfer",
    async (request, reply) => {
      const actor = getAdminSession(request),
        nonce = adminReauthNonce(request.headers.cookie);
      if (!nonce)
        return reply.code(409).send({ error: "Purpose-bound reauthentication is required" });
      try {
        return await jobRunner.runImmediateConfigurationMigration({
          actorId: actor.user.id,
          operationKey: createDurableOpsKey(
            "credential.import",
            `${actor.user.id}:${request.headers["idempotency-key"]}`,
          ),
          previewId: request.body.previewId,
          fingerprint: request.body.intentFingerprint,
          kind: "credentials",
          expectedCurrentRevisionId: request.body.expectedCurrentRevisionId,
          proof: {
            sessionId: actor.session.id,
            nonce,
            importProofToken: request.body.importProofToken,
            ...(request.body.transitProofToken
              ? { transitProofToken: request.body.transitProofToken }
              : {}),
          },
        });
      } catch {
        return reply.code(503).send({
          error: "Credential import did not settle; inspect Activity before another operation",
        });
      }
    },
    { preHandler: limit.preHandler() },
  );
}
