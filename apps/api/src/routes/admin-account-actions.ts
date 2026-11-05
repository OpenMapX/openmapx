import { accountProvisioningOperations } from "@openmapx/core/api-contracts";
import { isAPIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AccountProvisioningError,
  accountDelivery,
  assistedAccountAction,
  changeProvisionedAccountRole,
  provisionAccount,
} from "../account/account-provisioning";
import { AdminReauthenticationError } from "../account/admin-reauthentication";
import { getAdminSession } from "../utils/require-admin";
import { createAdminRouteRegistrar } from "./admin-contract";
import { adminReauthNonce } from "./admin-reauthentication";

const register = createAdminRouteRegistrar(accountProvisioningOperations, {
  tag: "account-admin",
  validationPhase: "preHandler",
});
function actor(request: FastifyRequest) {
  const value = getAdminSession(request);
  return {
    id: value.user.id,
    sessionId: value.session.id,
    headers: fromNodeHeaders(request.headers),
  };
}
function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminReauthenticationError)
    return reply.code(409).send({ error: error.code });
  if (error instanceof AccountProvisioningError) {
    if (error.statusCode === 429) reply.header("Retry-After", "3600");
    return reply
      .code(error.statusCode)
      .send({ error: error.code, ...(error.statusCode === 429 ? { retryAfter: 3600 } : {}) });
  }
  if (isAPIError(error)) {
    const code = error.body?.code;
    if (error.statusCode === 429) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "ACCOUNT_ACTION_RATE_LIMITED", retryAfter: 60 });
    }
    return reply.code(error.statusCode).send({
      error:
        typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "ACCOUNT_ACTION_FAILED",
    });
  }
  return reply.code(503).send({ error: "ACCOUNT_ACTION_UNAVAILABLE" });
}
export async function registerAccountActions(app: FastifyInstance) {
  register(app, "getAdminAccountDelivery", async (request, reply) => {
    try {
      return await accountDelivery(actor(request), request.params.userId);
    } catch (error) {
      return failure(error, reply);
    }
  });
  register(app, "createAdminAccount", async (request, reply) => {
    try {
      return await provisionAccount({
        ...request.body,
        actor: actor(request),
        idempotencyKey: request.headers["idempotency-key"] as string,
      });
    } catch (error) {
      return failure(error, reply);
    }
  });
  const actions = {
    inviteAdminAccount: "invitation",
    sendAdminAccountVerificationEmail: "verification-email",
    verifyAdminAccount: "verify",
    sendAdminAccountPasswordReset: "reset-password",
    setAdminAccountPassword: "password",
  } as const;
  for (const [operation, action] of Object.entries(actions))
    register(app, operation as keyof typeof actions, async (request, reply) => {
      try {
        const nonce = adminReauthNonce(request.headers.cookie);
        return await assistedAccountAction({
          action,
          userId: request.params.userId,
          body: request.body,
          actor: actor(request),
          idempotencyKey: request.headers["idempotency-key"] as string,
          ...(nonce
            ? {
                proof: {
                  challengeId: request.headers["x-openmapx-reauth-challenge"] as string,
                  nonce,
                },
              }
            : {}),
        });
      } catch (error) {
        return failure(error, reply);
      }
    });
  register(app, "changeAdminAccountRole", async (request, reply) => {
    try {
      return await changeProvisionedAccountRole({
        userId: request.params.userId,
        body: request.body,
        actor: actor(request),
        idempotencyKey: request.headers["idempotency-key"] as string,
      });
    } catch (error) {
      return failure(error, reply);
    }
  });
}
