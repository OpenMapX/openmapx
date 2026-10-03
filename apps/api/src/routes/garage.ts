import { MAX_VEHICLES_PER_USER, normalizeParkedDraft, normalizeVehicleDraft } from "@openmapx/core";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index";
import { parkedLocation, personalVehicle, user } from "../db/schema";
import { getUserId, requireAuthHook } from "../utils/require-auth";
import { declareRouteAuth } from "../utils/route-auth";

type GarageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Empty garages have no vehicle row to lock; serialize on their owning account. */
async function lockGarage(tx: GarageTransaction, userId: string): Promise<void> {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
}

export const garageRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "session");

  // Every route here is per-user; authenticate once so no handler can forget
  // the check and serve another user's garage.
  fastify.addHook("preHandler", requireAuthHook);
  // A parked position is precise personal location, so no shared cache may hold
  // one. Set on the hook rather than per handler: a missed header would be a
  // silent leak into an intermediary, with nothing failing to reveal it.
  fastify.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  fastify.get("/vehicles", async (req, reply) => {
    const userId = getUserId(req);
    const vehicles = await db
      .select()
      .from(personalVehicle)
      .where(eq(personalVehicle.userId, userId))
      .orderBy(desc(personalVehicle.isDefault), asc(personalVehicle.name));
    return reply.send({ vehicles });
  });

  fastify.post("/vehicles", async (req, reply) => {
    const userId = getUserId(req);
    const draft = normalizeVehicleDraft(req.body);
    if (!draft.ok) return reply.status(400).send({ error: draft.reason });

    const created = await db.transaction(async (tx) => {
      await lockGarage(tx, userId);
      const counted = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(personalVehicle)
        .where(eq(personalVehicle.userId, userId));
      const existing = counted[0]?.count ?? 0;
      if (existing >= MAX_VEHICLES_PER_USER) return null;
      const isDefault = draft.value.isDefault || existing === 0;
      const id = crypto.randomUUID();
      if (isDefault) {
        await tx
          .update(personalVehicle)
          .set({ isDefault: false })
          .where(eq(personalVehicle.userId, userId));
      }
      await tx.insert(personalVehicle).values({ id, userId, ...draft.value, isDefault });
      return { id, ...draft.value, isDefault };
    });
    if (!created) return reply.status(409).send({ error: "vehicle limit reached" });
    return reply.send(created);
  });

  fastify.patch("/vehicles/:id", async (req, reply) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };

    const error = await db.transaction(async (tx) => {
      await lockGarage(tx, userId);
      const existing = await tx
        .select()
        .from(personalVehicle)
        .where(and(eq(personalVehicle.id, id), eq(personalVehicle.userId, userId)))
        .limit(1);
      if (existing.length === 0) return { status: 404, error: "Vehicle not found" };
      const draft = normalizeVehicleDraft({
        ...existing[0],
        ...(req.body as Record<string, unknown>),
      });
      if (!draft.ok) return { status: 400, error: draft.reason };
      if (draft.value.isDefault) {
        await tx
          .update(personalVehicle)
          .set({ isDefault: false })
          .where(and(eq(personalVehicle.userId, userId), ne(personalVehicle.id, id)));
      }
      await tx
        .update(personalVehicle)
        .set(draft.value)
        .where(and(eq(personalVehicle.id, id), eq(personalVehicle.userId, userId)));
      return null;
    });
    if (error) return reply.status(error.status).send({ error: error.error });
    return reply.send({ ok: true });
  });

  fastify.delete("/vehicles/:id", async (req, reply) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };

    const deleted = await db.transaction(async (tx) => {
      await lockGarage(tx, userId);
      const existing = await tx
        .select({ id: personalVehicle.id, isDefault: personalVehicle.isDefault })
        .from(personalVehicle)
        .where(and(eq(personalVehicle.id, id), eq(personalVehicle.userId, userId)))
        .limit(1);
      if (existing.length === 0) return false;
      await tx
        .delete(personalVehicle)
        .where(and(eq(personalVehicle.id, id), eq(personalVehicle.userId, userId)));
      if (existing[0].isDefault) {
        const next = await tx
          .select({ id: personalVehicle.id })
          .from(personalVehicle)
          .where(eq(personalVehicle.userId, userId))
          .orderBy(asc(personalVehicle.createdAt), asc(personalVehicle.id))
          .limit(1);
        if (next.length)
          await tx
            .update(personalVehicle)
            .set({ isDefault: true })
            .where(and(eq(personalVehicle.id, next[0].id), eq(personalVehicle.userId, userId)));
      }
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "Vehicle not found" });
    return reply.send({ ok: true });
  });

  fastify.get("/parking", async (req, reply) => {
    const userId = getUserId(req);
    const parked = await db
      .select()
      .from(parkedLocation)
      .where(eq(parkedLocation.userId, userId))
      .orderBy(desc(parkedLocation.savedAt));
    return reply.send({ parked });
  });

  fastify.put("/parking", async (req, reply) => {
    const userId = getUserId(req);
    const draft = normalizeParkedDraft(req.body);
    if (!draft.ok) return reply.status(400).send({ error: draft.reason });

    // An unowned vehicleId is a 404, not a silently unassigned record: saving
    // "somewhere" when the user asked to save "for that car" is a wrong answer.
    if (draft.value.vehicleId !== null) {
      const owned = await db
        .select({ id: personalVehicle.id })
        .from(personalVehicle)
        .where(
          and(eq(personalVehicle.id, draft.value.vehicleId), eq(personalVehicle.userId, userId)),
        )
        .limit(1);
      if (owned.length === 0) {
        return reply.status(404).send({ error: "Vehicle not found" });
      }
    }

    const now = new Date();
    const expiresAt = draft.value.expiresAt ? new Date(draft.value.expiresAt) : null;
    const rows = await db
      .insert(parkedLocation)
      .values({
        id: crypto.randomUUID(),
        userId,
        ...draft.value,
        expiresAt,
        savedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [parkedLocation.userId, parkedLocation.vehicleId],
        set: {
          lat: draft.value.lat,
          lng: draft.value.lng,
          address: draft.value.address,
          note: draft.value.note,
          expiresAt,
          source: draft.value.source,
          accuracyMeters: draft.value.accuracyMeters,
          savedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return reply.send(rows[0] ?? null);
  });

  fastify.patch("/parking/:id", async (req, reply) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };

    const existing = await db
      .select()
      .from(parkedLocation)
      .where(and(eq(parkedLocation.id, id), eq(parkedLocation.userId, userId)))
      .limit(1);
    if (existing.length === 0) {
      return reply.status(404).send({ error: "Parked location not found" });
    }

    const current = existing[0];
    const merged = {
      ...current,
      expiresAt: current.expiresAt ? new Date(current.expiresAt).toISOString() : null,
      ...(req.body as Record<string, unknown>),
    };
    const draft = normalizeParkedDraft(merged);
    if (!draft.ok) return reply.status(400).send({ error: draft.reason });

    await db
      .update(parkedLocation)
      .set({
        lat: draft.value.lat,
        lng: draft.value.lng,
        address: draft.value.address,
        note: draft.value.note,
        expiresAt: draft.value.expiresAt ? new Date(draft.value.expiresAt) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(parkedLocation.id, id), eq(parkedLocation.userId, userId)));

    return reply.send({ ok: true });
  });

  fastify.delete("/parking/:id", async (req, reply) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };

    const removed = await db
      .delete(parkedLocation)
      .where(and(eq(parkedLocation.id, id), eq(parkedLocation.userId, userId)))
      .returning({ id: parkedLocation.id });
    if (removed.length === 0) {
      return reply.status(404).send({ error: "Parked location not found" });
    }
    return reply.send({ ok: true });
  });
};
