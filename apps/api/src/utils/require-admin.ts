import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../auth";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    adminSession?: AdminSession;
  }
}

/**
 * Returns the adminSession set by the preHandler hook.
 * Throws if it's missing (should never happen if requireAdmin preHandler is wired).
 */
export function getAdminSession(request: FastifyRequest): AdminSession {
  const s = request.adminSession;
  if (!s) throw new Error("adminSession not set — missing requireAdmin preHandler?");
  return s;
}

/**
 * Verifies the request has an active session with one of the allowed roles.
 * Replies with 401/403 and returns null on failure.
 * Returns the full session on success so callers can use it for audit logging.
 *
 * @param roles - Roles that are allowed (default: ["admin"])
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  roles: string[] = ["admin"],
): Promise<AdminSession | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    reply.status(401).send({ error: "Authentication required" });
    return null;
  }
  if (!session.user.role || !roles.includes(session.user.role)) {
    reply.status(403).send({ error: "Admin access required" });
    return null;
  }
  return session as AdminSession;
}
