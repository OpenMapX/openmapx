import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../auth";

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { fromNodeHeaders } = await import("better-auth/node");
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    reply.status(401).send({ error: "Authentication required" });
    return false;
  }
  if (session.user.role !== "admin") {
    reply.status(403).send({ error: "Admin access required" });
    return false;
  }
  return true;
}
