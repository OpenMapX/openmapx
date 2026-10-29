import { sharingPublicSchema } from "@openmapx/core/api-contracts";
import { httpError } from "@openmapx/integration-framework";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index";
import { savedList, savedPlace, shareLink, user } from "../db/schema";
import {
  generateShareToken,
  hashShareToken,
  isExpired,
  listSnapshotFrom,
  MAX_SHARES_PER_USER,
  MAX_SNAPSHOT_PLACES,
  parseStoredListSnapshot,
  routeShareLabel,
  toOwnerShare,
  toPublicListShare,
  toPublicRouteShare,
  validateRouteShare,
} from "../services/share-links";
import { shareMintLimit, shareResolveLimit } from "../utils/rate-limit";
import { getUserId, requireAuthHook } from "../utils/require-auth";
import { declareRouteAuth } from "../utils/route-auth";
import { registerSharingRoute } from "./sharing-contract";

/** Test hook: drop limiter buckets so injected requests never hit a stale 429. */
export function resetShareRateLimitsForTests(): void {
  shareResolveLimit.reset();
  shareMintLimit.reset();
}

const DAY_MS = 86_400_000;

export const sharesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  registerSharingRoute(
    fastify,
    "resolvePublicShare",
    async (req, reply) => {
      // Revocation and expiry must be immediate everywhere — never cacheable.
      reply.header("Cache-Control", "no-store");
      const { token } = req.params;
      const rows = await db
        .select()
        .from(shareLink)
        .where(eq(shareLink.tokenHash, hashShareToken(token)))
        .limit(1);
      const share = rows[0];
      // Uniform failure: unknown, expired, dangling, and corrupt all read the same.
      const gone = () => httpError(404, "Share link not found");
      if (!share || isExpired(share, new Date())) throw gone();
      const sendPublic = (value: unknown) => {
        const parsed = sharingPublicSchema.safeParse(value);
        if (!parsed.success) throw gone();
        return reply.send(parsed.data);
      };

      if (share.targetType === "route") {
        const route = validateRouteShare(share.snapshot);
        if (!route) throw gone();
        return sendPublic(toPublicRouteShare(route));
      }

      if (share.mode === "snapshot") {
        const snap = parseStoredListSnapshot(share.snapshot);
        if (!snap) throw gone();
        return sendPublic(toPublicListShare("snapshot", snap));
      }

      const lists = await db
        .select()
        .from(savedList)
        .where(and(eq(savedList.id, share.targetId ?? ""), eq(savedList.userId, share.userId)))
        .limit(1);
      const list = lists[0];
      if (!list) throw gone();
      const places = await db
        .select()
        .from(savedPlace)
        .where(eq(savedPlace.listId, list.id))
        .orderBy(savedPlace.sortOrder)
        .limit(MAX_SNAPSHOT_PLACES);
      const snap = listSnapshotFrom(list, places);
      if (!snap) throw gone();
      return sendPublic(toPublicListShare("live", snap));
    },
    { preHandler: shareResolveLimit.preHandler() },
  );

  await fastify.register(async (authenticated) => {
    declareRouteAuth(authenticated, "session");
    authenticated.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Cookie");
    });
    authenticated.addHook("preHandler", requireAuthHook);

    registerSharingRoute(
      authenticated,
      "createShare",
      async (req, reply) => {
        const userId = getUserId(req);
        const body = req.body;

        const result = await db.transaction(async (tx) => {
          // Lock the owner even when no shares exist; serialize count and insert
          // across all API processes competing for the same user's quota.
          await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
          const [{ count }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(shareLink)
            .where(eq(shareLink.userId, userId));
          if (count >= MAX_SHARES_PER_USER) {
            throw httpError(409, "Share link limit reached — delete an existing link first");
          }

          const now = new Date();
          const expiresAt = body.expiresInDays
            ? new Date(now.getTime() + body.expiresInDays * DAY_MS)
            : null;
          const id = crypto.randomUUID();
          const token = generateShareToken();

          let row: typeof shareLink.$inferInsert;
          if (body.targetType === "list") {
            if (!body.targetId || !body.mode) {
              throw httpError(400, "List shares require targetId and mode");
            }
            const lists = await tx
              .select()
              .from(savedList)
              .where(and(eq(savedList.id, body.targetId), eq(savedList.userId, userId)))
              .limit(1);
            const list = lists[0];
            if (!list) throw httpError(404, "List not found");
            let snapshot: ReturnType<typeof listSnapshotFrom> = null;
            if (body.mode === "snapshot") {
              const places = await tx
                .select()
                .from(savedPlace)
                .where(eq(savedPlace.listId, list.id))
                .orderBy(savedPlace.sortOrder)
                .limit(MAX_SNAPSHOT_PLACES + 1);
              if (places.length > MAX_SNAPSHOT_PLACES) {
                throw httpError(
                  400,
                  `Lists over ${MAX_SNAPSHOT_PLACES} places cannot be shared as a snapshot`,
                );
              }
              snapshot = listSnapshotFrom(list, places);
              if (!snapshot) throw httpError(400, "Invalid list snapshot");
            }
            row = {
              id,
              userId,
              tokenHash: hashShareToken(token),
              targetType: "list",
              targetId: list.id,
              mode: body.mode,
              label: list.name,
              snapshot,
              createdAt: now,
              updatedAt: now,
              expiresAt,
            };
          } else {
            const route = validateRouteShare(body.route);
            if (!route) throw httpError(400, "Invalid route payload");
            row = {
              id,
              userId,
              tokenHash: hashShareToken(token),
              targetType: "route",
              targetId: null,
              mode: "snapshot",
              label: routeShareLabel(route),
              snapshot: route,
              createdAt: now,
              updatedAt: now,
              expiresAt,
            };
          }

          await tx.insert(shareLink).values(row);
          return {
            id,
            token,
            share: toOwnerShare({
              id,
              targetType: row.targetType,
              targetId: row.targetId ?? null,
              mode: row.mode,
              label: row.label,
              createdAt: now,
              updatedAt: now,
              expiresAt,
            }),
          };
        });
        return reply.status(201).send(result);
      },
      { preHandler: shareMintLimit.preHandler() },
    );

    registerSharingRoute(authenticated, "listOwnerShares", async (req, _reply) => {
      const userId = getUserId(req);
      const rows = await db
        .select()
        .from(shareLink)
        .where(eq(shareLink.userId, userId))
        .orderBy(desc(shareLink.createdAt));
      return { shares: rows.map(toOwnerShare) };
    });

    registerSharingRoute(
      authenticated,
      "rotateShareToken",
      async (req, reply) => {
        const userId = getUserId(req);
        const { id } = req.params;
        const token = generateShareToken();
        const updated = await db
          .update(shareLink)
          .set({ tokenHash: hashShareToken(token), updatedAt: new Date() })
          .where(and(eq(shareLink.id, id), eq(shareLink.userId, userId)))
          .returning({ id: shareLink.id });
        if (updated.length === 0) throw httpError(404, "Share link not found");
        return reply.send({ token });
      },
      { preHandler: shareMintLimit.preHandler() },
    );

    registerSharingRoute(authenticated, "revokeShare", async (req, reply) => {
      const userId = getUserId(req);
      const { id } = req.params;
      const deleted = await db
        .delete(shareLink)
        .where(and(eq(shareLink.id, id), eq(shareLink.userId, userId)))
        .returning({ id: shareLink.id });
      if (deleted.length === 0) throw httpError(404, "Share link not found");
      return reply.send({ ok: true });
    });
  });
};
