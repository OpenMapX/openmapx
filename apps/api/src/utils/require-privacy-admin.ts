import { httpError } from "@openmapx/integration-framework";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "../auth.js";
import type { AdminSession } from "./require-admin.js";

export type PrivacyAdminSession = AdminSession;

declare module "fastify" {
  interface FastifyRequest {
    privacyAdminSession?: PrivacyAdminSession;
  }
}

/**
 * Require a human session that is allowed to work privacy cases.  This guard
 * intentionally does not share the loopback shortcut in requireAdmin: a
 * privacy decision must always have an attributable account and session.
 */
export async function requirePrivacyAdmin(request: FastifyRequest): Promise<PrivacyAdminSession> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw httpError(401, "Authentication required");
  if (session.user.id === "loopback") throw httpError(403, "Privacy administrator access required");
  if (session.user.role !== "admin" && session.user.role !== "privacy_admin") {
    throw httpError(403, "Privacy administrator access required");
  }
  const result = session as PrivacyAdminSession;
  request.privacyAdminSession = result;
  return result;
}

export function getPrivacyAdminSession(request: FastifyRequest): PrivacyAdminSession {
  const session = request.privacyAdminSession;
  if (!session) throw new Error("privacyAdminSession not set — missing requirePrivacyAdmin guard?");
  return session;
}
