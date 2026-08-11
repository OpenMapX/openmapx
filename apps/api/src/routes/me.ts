import { fromNodeHeaders } from "better-auth/node";
import type { FastifyPluginAsync } from "fastify";
import { auth } from "../auth";
import { toPublicSession } from "../utils/public-session";
import { declareRouteAuth } from "../utils/route-auth";

/**
 * Current session for the signed-in caller. The response is projected to a
 * declared shape rather than forwarding better-auth's session object as-is:
 * that object carries the session token, the stored client IP address, the
 * user agent and the impersonation marker, none of which a caller needs.
 */
export const meRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "session");

  fastify.get("/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return reply.send(toPublicSession(session));
  });
};
