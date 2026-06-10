import { httpError } from "@openmapx/integration-framework";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "../auth";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Resolve the authenticated user id, or throw a 401 that Fastify's error
 * handler turns into the response. Throwing (rather than sending + returning a
 * nullable) means a caller cannot forget to `return reply` after a failed
 * check — the request can never fall through to a second send.
 */
export async function requireAuth(request: FastifyRequest): Promise<string> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw httpError(401, "Authentication required");
  return session.user.id;
}

/**
 * preHandler that authenticates the request and stashes the user id, so the
 * routes in a plugin can't individually forget the check (a missed opener would
 * otherwise serve another user's data with no compile error). Mirrors the admin
 * routes' requireAdmin preHandler + getAdminSession accessor.
 */
export async function requireAuthHook(request: FastifyRequest): Promise<void> {
  request.userId = await requireAuth(request);
}

/** Read the user id set by {@link requireAuthHook}. Throws if the hook is unwired. */
export function getUserId(request: FastifyRequest): string {
  if (!request.userId) throw new Error("userId not set — missing requireAuth preHandler?");
  return request.userId;
}
