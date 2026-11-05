import { adminReauthOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_REAUTH_COOKIE_NAME,
  AdminActionReauthentication,
  AdminReauthenticationError,
} from "../account/admin-reauthentication";
import { getSessionAuthAssurance } from "../privacy/session-assurance";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";
export function adminReauthNonce(cookie: string | undefined): Buffer | undefined {
  const values = cookie
    ?.split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${ADMIN_REAUTH_COOKIE_NAME}=`));
  if (values?.length !== 1) return;
  const value = values[0]?.slice(ADMIN_REAUTH_COOKIE_NAME.length + 1);
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) return;
  const nonce = Buffer.from(value, "base64url");
  return nonce.length === 32 ? nonce : undefined;
}
const register = createAdminRouteRegistrar(adminReauthOperations, {
  tag: "account-admin",
  validationPhase: "preHandler",
});
export async function adminReauthenticationRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request, reply) => {
    request.adminSession = await requireAdmin(request);
    const actor = getAdminSession(request);
    if (actor.user.id === "loopback" || actor.session.impersonatedBy)
      return reply.code(403).send({ error: "A real full administrator session is required" });
  });
  const limits = () =>
      new RateLimiter({ max: 5, windowMs: 60000, keyFn: (req) => getAdminSession(req).user.id }),
    startLimit = limits(),
    completeLimit = limits();
  app.addHook("onClose", async () => {
    startLimit.destroy();
    completeLimit.destroy();
  });
  register(
    app,
    "startAdminReauthentication",
    async (request, reply) => {
      try {
        const actor = getAdminSession(request),
          proof = await new AdminActionReauthentication().start({
            ...request.body,
            actorId: actor.user.id,
            startingSessionId: actor.session.id,
            nonce: adminReauthNonce(request.headers.cookie),
            idempotencyKey: request.headers["idempotency-key"] as string,
          });
        reply.header("Cache-Control", "no-store");
        reply.header(
          "Set-Cookie",
          `${ADMIN_REAUTH_COOKIE_NAME}=${proof.nonce.toString("base64url")}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((proof.expiresAt.getTime() - Date.now()) / 1000))}`,
        );
        return {
          challengeId: proof.challengeId,
          expiresAt: proof.expiresAt.toISOString(),
          loginPath: "/auth/admin" as const,
        };
      } catch (error) {
        return reply.code(error instanceof AdminReauthenticationError ? 409 : 503).send({
          error:
            error instanceof AdminReauthenticationError
              ? error.code
              : "REAUTHENTICATION_UNAVAILABLE",
        });
      }
    },
    { preHandler: [startLimit.preHandler()] },
  );
  register(
    app,
    "completeAdminReauthentication",
    async (request, reply) => {
      const nonce = adminReauthNonce(request.headers.cookie);
      reply.header("Cache-Control", "no-store");
      if (!nonce) return reply.code(409).send({ error: "REAUTHENTICATION_FAILED" });
      try {
        const actor = getAdminSession(request),
          assurance = await getSessionAuthAssurance(actor.session.id);
        if (!assurance) throw new AdminReauthenticationError();
        await new AdminActionReauthentication().complete({
          challengeId: request.body.challengeId,
          nonce,
          session: {
            id: actor.session.id,
            userId: actor.user.id,
            authenticatedAt: assurance.authenticatedAt,
            method: assurance.method,
            mfaConfigured: actor.user.twoFactorEnabled === true,
          },
        });
        return { completed: true as const };
      } catch (error) {
        return reply.code(error instanceof AdminReauthenticationError ? 409 : 503).send({
          error:
            error instanceof AdminReauthenticationError
              ? error.code
              : "REAUTHENTICATION_UNAVAILABLE",
        });
      }
    },
    { preHandler: [completeLimit.preHandler()] },
  );
}
