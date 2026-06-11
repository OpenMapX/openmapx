import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index";
import { labeledPlace, savedList, savedPlace } from "../db/schema";
import {
  EXPORT_CONTENT_TYPE,
  EXPORT_EXTENSION,
  type ExportFormat,
  type ExportPlace,
  exportFilename,
  placesToGeoJson,
  placesToGpx,
  placesToKml,
} from "../utils/geo-export";
import { getUserId, requireAuthHook } from "../utils/require-auth";

const DEFAULT_LISTS: { name: string; icon: string; sortOrder: number }[] = [
  { name: "$favorites", icon: "heart", sortOrder: 0 },
  { name: "$wantToGo", icon: "flag", sortOrder: 1 },
  { name: "$starredPlaces", icon: "star", sortOrder: 2 },
];

export const savedRoute: FastifyPluginAsync = async (fastify) => {
  // Every /saved route is per-user; authenticate once here so no handler can
  // forget the check (which would silently expose another user's data).
  fastify.addHook("preHandler", requireAuthHook);

  fastify.get("/saved/lists", async (req, _reply) => {
    const userId = getUserId(req);

    const placeCount = sql<number>`(SELECT COUNT(*) FROM saved_place WHERE saved_place.list_id = saved_list.id)::int`;

    let lists = await db
      .select({
        id: savedList.id,
        name: savedList.name,
        icon: savedList.icon,
        isPrivate: savedList.isPrivate,
        sortOrder: savedList.sortOrder,
        createdAt: savedList.createdAt,
        updatedAt: savedList.updatedAt,
        placeCount,
      })
      .from(savedList)
      .where(eq(savedList.userId, userId))
      .orderBy(savedList.sortOrder);

    if (lists.length === 0) {
      const now = new Date();
      const rows = DEFAULT_LISTS.map((d) => ({
        id: crypto.randomUUID(),
        userId,
        name: d.name,
        icon: d.icon,
        sortOrder: d.sortOrder,
        createdAt: now,
        updatedAt: now,
      }));
      await db.insert(savedList).values(rows).onConflictDoNothing();
      lists = rows.map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon,
        isPrivate: true,
        sortOrder: r.sortOrder,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        placeCount: 0,
      }));
    }

    return { lists };
  });

  fastify.post("/saved/lists", {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 200 },
          icon: { type: "string", maxLength: 50 },
          isPrivate: { type: "boolean" },
        },
      },
    },
    handler: async (req, _reply) => {
      const userId = getUserId(req);

      const body = req.body as { name: string; icon?: string; isPrivate?: boolean };

      const id = crypto.randomUUID();
      const now = new Date();
      await db.insert(savedList).values({
        id,
        userId,
        name: body.name,
        icon: body.icon ?? null,
        isPrivate: body.isPrivate ?? true,
        createdAt: now,
        updatedAt: now,
      });

      return { id, name: body.name, icon: body.icon ?? null, isPrivate: body.isPrivate ?? true };
    },
  });

  fastify.patch("/saved/lists/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          icon: { type: "string", maxLength: 50 },
          isPrivate: { type: "boolean" },
          sortOrder: { type: "number" },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = getUserId(req);

      const { id } = req.params as { id: string };
      const body = req.body as {
        name?: string;
        icon?: string;
        isPrivate?: boolean;
        sortOrder?: number;
      };

      // Check if this is a default list (name starts with $)
      const existing = await db
        .select({ name: savedList.name })
        .from(savedList)
        .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
        .limit(1);

      if (existing.length === 0) {
        return reply.status(404).send({ error: "List not found" });
      }

      const isDefault = existing[0].name.startsWith("$");

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined && !isDefault) updates.name = body.name;
      if (body.icon !== undefined && !isDefault) updates.icon = body.icon;
      if (body.isPrivate !== undefined) updates.isPrivate = body.isPrivate;
      if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      const result = await db
        .update(savedList)
        .set(updates)
        .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
        .returning({ id: savedList.id });

      if (result.length === 0) {
        return reply.status(404).send({ error: "List not found" });
      }

      return { ok: true };
    },
  });

  fastify.delete("/saved/lists/:id", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params as { id: string };

    const existing = await db
      .select({ name: savedList.name })
      .from(savedList)
      .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
      .limit(1);

    if (existing.length === 0) {
      return reply.status(404).send({ error: "List not found" });
    }

    if (existing[0].name.startsWith("$")) {
      return reply.status(400).send({ error: "Default lists cannot be deleted" });
    }

    await db.delete(savedList).where(and(eq(savedList.id, id), eq(savedList.userId, userId)));

    return { ok: true };
  });

  fastify.get("/saved/lists/:id/places", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params as { id: string };

    const list = await db
      .select({ id: savedList.id })
      .from(savedList)
      .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
      .limit(1);

    if (list.length === 0) {
      return reply.status(404).send({ error: "List not found" });
    }

    const places = await db
      .select()
      .from(savedPlace)
      .where(eq(savedPlace.listId, id))
      .orderBy(savedPlace.sortOrder);

    return { places };
  });

  fastify.get<{ Params: { id: string }; Querystring: { format?: ExportFormat } }>(
    "/saved/lists/:id/export",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["gpx", "geojson", "kml"], default: "geojson" },
          },
        },
      },
      handler: async (req, reply) => {
        const userId = getUserId(req);
        const { id } = req.params;
        const format = (req.query.format ?? "geojson") as ExportFormat;

        const list = await db
          .select({ id: savedList.id, name: savedList.name })
          .from(savedList)
          .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
          .limit(1);

        if (list.length === 0) {
          return reply.status(404).send({ error: "List not found" });
        }

        const rows = await db
          .select()
          .from(savedPlace)
          .where(eq(savedPlace.listId, id))
          .orderBy(savedPlace.sortOrder);

        const places: ExportPlace[] = rows.map((p) => ({
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          address: p.address,
          note: p.note,
          placeId: p.placeId,
        }));

        const body =
          format === "geojson"
            ? JSON.stringify(placesToGeoJson(places))
            : format === "gpx"
              ? placesToGpx(places)
              : placesToKml(places);

        const asciiName = exportFilename(list[0].name, format);
        const utf8Name = `${encodeURIComponent(list[0].name.replace(/^\$/, ""))}.${EXPORT_EXTENSION[format]}`;

        return reply
          .type(`${EXPORT_CONTENT_TYPE[format]}; charset=utf-8`)
          .header(
            "Content-Disposition",
            `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
          )
          .send(body);
      },
    },
  );

  fastify.post("/saved/lists/:id/places", {
    schema: {
      body: {
        type: "object",
        required: ["name", "lat", "lng"],
        properties: {
          name: { type: "string", maxLength: 500 },
          address: { type: "string", maxLength: 500 },
          lat: { type: "number" },
          lng: { type: "number" },
          placeId: { type: "string", maxLength: 200 },
          note: { type: "string", maxLength: 2000 },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = getUserId(req);

      const { id: listId } = req.params as { id: string };

      const list = await db
        .select({ id: savedList.id })
        .from(savedList)
        .where(and(eq(savedList.id, listId), eq(savedList.userId, userId)))
        .limit(1);

      if (list.length === 0) {
        return reply.status(404).send({ error: "List not found" });
      }

      const body = req.body as {
        name?: string;
        address?: string;
        lat?: number;
        lng?: number;
        placeId?: string;
        note?: string;
      };

      if (!body.name || body.lat === undefined || body.lng === undefined) {
        return reply.status(400).send({ error: "name, lat, and lng are required" });
      }

      const id = crypto.randomUUID();
      await db.insert(savedPlace).values({
        id,
        listId,
        name: body.name,
        address: body.address ?? null,
        lat: body.lat,
        lng: body.lng,
        placeId: body.placeId ?? null,
        note: body.note ?? null,
      });

      return { id, listId, name: body.name, lat: body.lat, lng: body.lng };
    },
  });

  fastify.patch("/saved/places/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 500 },
          address: { type: "string", maxLength: 500 },
          note: { type: "string", maxLength: 2000 },
          sortOrder: { type: "number" },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = getUserId(req);

      const { id } = req.params as { id: string };

      const existing = await db
        .select({ placeId: savedPlace.id, listUserId: savedList.userId })
        .from(savedPlace)
        .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
        .where(eq(savedPlace.id, id))
        .limit(1);

      if (existing.length === 0 || existing[0].listUserId !== userId) {
        return reply.status(404).send({ error: "Place not found" });
      }

      const body = req.body as {
        name?: string;
        address?: string;
        note?: string;
        sortOrder?: number;
      };

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.address !== undefined) updates.address = body.address;
      if (body.note !== undefined) updates.note = body.note;
      if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      await db
        .update(savedPlace)
        .set(updates)
        .where(
          and(
            eq(savedPlace.id, id),
            sql`${savedPlace.listId} IN (SELECT id FROM saved_list WHERE user_id = ${userId})`,
          ),
        );

      return { ok: true };
    },
  });

  fastify.delete("/saved/places/:id", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params as { id: string };

    const existing = await db
      .select({ placeId: savedPlace.id, listUserId: savedList.userId })
      .from(savedPlace)
      .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
      .where(eq(savedPlace.id, id))
      .limit(1);

    if (existing.length === 0 || existing[0].listUserId !== userId) {
      return reply.status(404).send({ error: "Place not found" });
    }

    await db
      .delete(savedPlace)
      .where(
        and(
          eq(savedPlace.id, id),
          sql`${savedPlace.listId} IN (SELECT id FROM saved_list WHERE user_id = ${userId})`,
        ),
      );

    return { ok: true };
  });

  fastify.get("/saved/labels", async (req, _reply) => {
    const userId = getUserId(req);

    const labels = await db.select().from(labeledPlace).where(eq(labeledPlace.userId, userId));

    return { labels };
  });

  fastify.put("/saved/labels/:label", {
    schema: {
      body: {
        type: "object",
        required: ["name", "lat", "lng"],
        properties: {
          name: { type: "string", maxLength: 500 },
          address: { type: "string", maxLength: 500 },
          lat: { type: "number" },
          lng: { type: "number" },
          placeId: { type: "string", maxLength: 200 },
          icon: { type: "string", maxLength: 50 },
        },
      },
    },
    handler: async (req, _reply) => {
      const userId = getUserId(req);

      const { label } = req.params as { label: string };
      const body = req.body as {
        name: string;
        address?: string;
        lat: number;
        lng: number;
        placeId?: string;
        icon?: string;
      };

      const existing = await db
        .select({ id: labeledPlace.id })
        .from(labeledPlace)
        .where(and(eq(labeledPlace.userId, userId), eq(labeledPlace.label, label)))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(labeledPlace)
          .set({
            name: body.name,
            address: body.address ?? null,
            lat: body.lat,
            lng: body.lng,
            placeId: body.placeId ?? null,
            icon: body.icon ?? null,
          })
          .where(eq(labeledPlace.id, existing[0].id));

        return { id: existing[0].id, label };
      }

      const id = crypto.randomUUID();
      await db.insert(labeledPlace).values({
        id,
        userId,
        label,
        name: body.name,
        address: body.address ?? null,
        lat: body.lat,
        lng: body.lng,
        placeId: body.placeId ?? null,
        icon: body.icon ?? null,
      });

      return { id, label };
    },
  });

  fastify.delete("/saved/labels/:label", async (req, reply) => {
    const userId = getUserId(req);

    const { label } = req.params as { label: string };

    const result = await db
      .delete(labeledPlace)
      .where(and(eq(labeledPlace.userId, userId), eq(labeledPlace.label, label)))
      .returning({ id: labeledPlace.id });

    if (result.length === 0) {
      return reply.status(404).send({ error: "Label not found" });
    }

    return { ok: true };
  });

  fastify.get<{ Querystring: { placeId: string } }>("/saved/check", async (req, reply) => {
    const userId = getUserId(req);

    const { placeId } = req.query;
    if (!placeId) {
      return reply.status(400).send({ error: "placeId query parameter is required" });
    }

    const rows = await db
      .select({ listId: savedPlace.listId })
      .from(savedPlace)
      .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
      .where(and(eq(savedPlace.placeId, placeId), eq(savedList.userId, userId)));

    return { listIds: rows.map((r) => r.listId) };
  });
};
