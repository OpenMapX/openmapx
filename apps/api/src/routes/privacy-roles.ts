import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import { adminAuditLog, session, user } from "../db/schema.js";
import { getAdminSession, requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";

const userIdParam = z.object({ userId: z.string().min(1).max(256) }).strict();
const emptyBody = z.object({}).strict();
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;

export interface PrivacyRolesRouteOptions {
  database?: typeof defaultDb;
}

/**
 * Full-admin-only privacy role management.  Better Auth's broad admin plugin
 * intentionally remains limited to `admin`/`user`; this endpoint is the sole
 * path that grants the least-privilege `privacy_admin` role.
 */
export const privacyRolesRoute: FastifyPluginAsync<PrivacyRolesRouteOptions> = async (
  fastify,
  options,
) => {
  declareRouteAuth(fastify, "admin");
  fastify.addHook("preHandler", async (request, reply) => {
    const actor = await requireAdmin(request);
    if (actor.user.id === "loopback" || actor.user.role !== "admin")
      return reply.status(403).send({ code: "FULL_ADMIN_REQUIRED" });
    request.adminSession = actor;
  });
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const database = options.database ?? defaultDb;

  const mutationKey = (request: {
    headers: { [key: string]: string | string[] | undefined };
  }): string | null => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && keyPattern.test(value) ? value : null;
  };

  async function changeRole(
    request: {
      params: unknown;
      body: unknown;
      headers: { [key: string]: string | string[] | undefined };
    },
    reply: {
      status(code: number): { send(value: unknown): unknown };
      send(value: unknown): unknown;
    },
    desired: "privacy_admin" | "user",
  ) {
    const params = userIdParam.safeParse(request.params);
    const body = emptyBody.safeParse(request.body ?? {});
    const key = mutationKey(request);
    if (!params.success || !body.success || !key)
      return reply.status(400).send({ code: "INVALID_ROLE_MUTATION" });
    const actor = getAdminSession(request as never);
    const targetId = params.data.userId;
    if (targetId === "loopback") return reply.status(404).send({ code: "USER_NOT_FOUND" });
    const [target] = await database
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.id, targetId))
      .limit(1);
    if (!target) return reply.status(404).send({ code: "USER_NOT_FOUND" });
    // Existing desired state is an idempotent no-op.  Full admins can never be
    // downgraded by this endpoint, even if a client changes the URL/action.
    if (target.role === "admin") return reply.status(409).send({ code: "FULL_ADMIN_PROTECTED" });
    if ((target.role ?? "user") === desired)
      return reply.send({ userId: target.id, role: desired, changed: false });
    const previousRole = target.role ?? "user";
    await database.transaction(async (tx) => {
      const updated = await tx
        .update(user)
        .set({ role: desired, updatedAt: new Date() })
        .where(
          and(
            eq(user.id, targetId),
            or(isNull(user.role), eq(user.role, "user"), eq(user.role, "privacy_admin")),
          ),
        )
        .returning({ id: user.id });
      if (!updated[0]) throw new Error("ROLE_VERSION_CONFLICT");
      // Role changes invalidate all existing sessions (and their recorded
      // authentication assurance) before the new least-privilege session is
      // used.  This prevents a stale session from retaining old authority.
      await tx.delete(session).where(eq(session.userId, targetId));
      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        actorId: actor.user.id,
        targetId,
        targetType: "user",
        action: desired === "privacy_admin" ? "privacy.role.grant" : "privacy.role.revoke",
        details: {
          role: desired,
          previousRole,
          mutationDigest: createHash("sha256").update(key).digest("hex").slice(0, 32),
        },
        ipAddress: null,
        userAgent: "privacy-role-admin",
        createdAt: new Date(),
      });
    });
    return reply.send({ userId: target.id, role: desired, changed: true });
  }

  fastify.post<{ Params: { userId: string }; Body: unknown }>(
    "/privacy/admin/roles/:userId/grant",
    async (request, reply) => changeRole(request, reply, "privacy_admin"),
  );
  fastify.post<{ Params: { userId: string }; Body: unknown }>(
    "/privacy/admin/roles/:userId/revoke",
    async (request, reply) => changeRole(request, reply, "user"),
  );
};
