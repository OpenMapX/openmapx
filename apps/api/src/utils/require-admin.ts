import { httpError } from "@openmapx/integration-framework";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "../auth";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    adminSession?: AdminSession;
  }
}

/**
 * Returns the adminSession set by the onRequest hook.
 * Throws if it's missing (should never happen if the requireAdmin hook is wired).
 */
export function getAdminSession(request: FastifyRequest): AdminSession {
  const s = request.adminSession;
  if (!s) throw new Error("adminSession not set — missing requireAdmin onRequest hook?");
  return s;
}

type AdminResolution = { session: AdminSession } | { error: 401 | 403 };

/**
 * Resolve an admin session without touching the reply: the Better Auth
 * session and its role. Every caller, the host CLI included, authenticates as
 * a real administrator; no address or header stands in for a session. Returns
 * the failing status code instead of sending, so both the throwing and
 * non-throwing entry points can share one code path.
 */
async function resolveAdmin(request: FastifyRequest, roles: string[]): Promise<AdminResolution> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return { error: 401 };
  if (!session.user.role || !roles.includes(session.user.role)) return { error: 403 };
  return { session: session as AdminSession };
}

/**
 * Require an active session with one of the allowed roles, returning the full
 * session (for audit logging) or throwing a 401/403 that Fastify's error
 * handler turns into the response. Throwing means a caller cannot forget to
 * `return reply` after a failed check.
 *
 * @param roles - Roles that are allowed (default: ["admin"])
 */
export async function requireAdmin(
  request: FastifyRequest,
  roles: string[] = ["admin"],
): Promise<AdminSession> {
  const r = await resolveAdmin(request, roles);
  if ("error" in r) {
    throw r.error === 401
      ? httpError(401, "Authentication required")
      : httpError(403, "Admin access required");
  }
  return r.session;
}

/**
 * Non-throwing admin check for callers that must branch on the result rather
 * than abort the request (e.g. the data-manager proxy, which reports a denial
 * to its own caller). Returns the session or null; never sends or throws.
 */
export async function tryAdminSession(
  request: FastifyRequest,
  roles: string[] = ["admin"],
): Promise<AdminSession | null> {
  const r = await resolveAdmin(request, roles);
  return "error" in r ? null : r.session;
}
