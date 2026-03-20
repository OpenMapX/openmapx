import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../auth";

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    reply.status(401).send({ error: "Authentication required" });
    return null;
  }
  return session.user.id;
}
