import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "../auth";
import { httpError } from "./http-error.js";

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
