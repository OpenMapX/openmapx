import type { SavedConflictCode } from "@openmapx/core/api-contracts";
import {
  isSystemSavedList,
  MAX_SAVED_LISTS_PER_USER,
  MAX_SAVED_PLACES_PER_USER,
} from "@openmapx/core/saved-lists";
import {
  parseSavedPlaceContributors,
  SAVED_PLACE_FIELDS,
} from "@openmapx/core/saved-place-contributors";
import {
  EXPORT_CONTENT_TYPE,
  EXPORT_EXTENSION,
  type ExportPlace,
  exportFilename,
  placesToGeoJson,
  placesToGpx,
  placesToKml,
} from "@openmapx/core/saved-place-export";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index";
import { SAVED_LIST_NAME_UNIQUE } from "../db/saved-schema";
import { labeledPlace, savedList, savedPlace, user } from "../db/schema";
import { isUniqueViolation } from "../db/unique-violation";
import { savedImportLimit } from "../utils/rate-limit";
import { getUserId, requireAuthHook } from "../utils/require-auth";
import { declareRouteAuth } from "../utils/route-auth";
import { registerSavedImportRoute, registerSavedRoute } from "./saved-contract";

// Positions are not unique, and a row can be inserted at an existing one. Ties
// fall back to creation time and then the primary key, so a listing keeps one
// order from request to request.
const LIST_ORDER = [savedList.sortOrder, savedList.createdAt, savedList.id] as const;
const PLACE_ORDER = [savedPlace.sortOrder, savedPlace.createdAt, savedPlace.id] as const;

const DEFAULT_LISTS: { name: string; icon: string; sortOrder: number }[] = [
  { name: "$favorites", icon: "heart", sortOrder: 0 },
  { name: "$wantToGo", icon: "flag", sortOrder: 1 },
  { name: "$starredPlaces", icon: "star", sortOrder: 2 },
];

type SavedTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CONFLICT_ERRORS: Record<SavedConflictCode, string> = {
  SAVED_LIST_LIMIT: `Accounts can have at most ${MAX_SAVED_LISTS_PER_USER} saved lists`,
  SAVED_PLACE_LIMIT: `Accounts can save at most ${MAX_SAVED_PLACES_PER_USER} places`,
  SAVED_LIST_NAME_TAKEN: "A list with this name already exists",
};

/** Thrown inside a transaction so nothing it already wrote is kept. */
class SavedLimitError extends Error {
  constructor(readonly code: SavedConflictCode) {
    super(CONFLICT_ERRORS[code]);
  }
}

function conflictBody(code: SavedConflictCode) {
  return { error: CONFLICT_ERRORS[code], code };
}

/** A failed write has already rolled back; only a repeated list name becomes a 409. */
function rethrowUnlessNameTaken(error: unknown): "name-taken" {
  if (isUniqueViolation(error, SAVED_LIST_NAME_UNIQUE)) return "name-taken";
  throw error;
}

/**
 * Serializes every write that adds lists or places for one account, so two
 * concurrent requests cannot both pass a count check. NO KEY UPDATE conflicts
 * with itself but not with the key-share locks that foreign-key checks take,
 * so ordinary inserts referencing the account are not blocked.
 */
async function lockSavedQuota(tx: SavedTransaction, userId: string): Promise<void> {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
}

async function countSavedLists(tx: SavedTransaction, userId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(savedList)
    .where(eq(savedList.userId, userId));
  return row?.count ?? 0;
}

async function countSavedPlaces(tx: SavedTransaction, userId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(savedPlace)
    .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
    .where(eq(savedList.userId, userId));
  return row?.count ?? 0;
}

export const savedRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "session");

  // Every /saved route is per-user; authenticate once here so no handler can
  // forget the check (which would silently expose another user's data).
  fastify.addHook("onRequest", requireAuthHook);
  // Saved places are personal location data, so no shared cache may hold a
  // response. Set on the hook rather than per handler so a new route or an
  // error response cannot miss it.
  fastify.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  registerSavedRoute(fastify, "listSavedLists", async (req, _reply) => {
    const userId = getUserId(req);

    const placeCount = sql<number>`(SELECT COUNT(*) FROM saved_place WHERE saved_place.list_id = saved_list.id)::int`;

    const readLists = () =>
      db
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
        .orderBy(...LIST_ORDER);

    let lists = await readLists();

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
      // A concurrent request may have inserted these names with different IDs.
      // Return the persisted rows, including any places already saved to them.
      lists = await readLists();
    }

    return { lists };
  });

  registerSavedRoute(fastify, "createSavedList", async (req, reply) => {
    const userId = getUserId(req);

    const body = req.body;
    if (body.name.startsWith("$")) {
      return reply.status(400).send({ error: "List names cannot start with $" });
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const created = await db
      .transaction(async (tx) => {
        await lockSavedQuota(tx, userId);
        if ((await countSavedLists(tx, userId)) >= MAX_SAVED_LISTS_PER_USER) return false;
        await tx.insert(savedList).values({
          id,
          userId,
          name: body.name,
          icon: body.icon ?? null,
          isPrivate: body.isPrivate ?? true,
          createdAt: now,
          updatedAt: now,
        });
        return true;
      })
      .catch(rethrowUnlessNameTaken);
    if (created === "name-taken")
      return reply.status(409).send(conflictBody("SAVED_LIST_NAME_TAKEN"));
    if (!created) return reply.status(409).send(conflictBody("SAVED_LIST_LIMIT"));

    return { id, name: body.name, icon: body.icon ?? null, isPrivate: body.isPrivate ?? true };
  });

  registerSavedImportRoute(
    fastify,
    "importSavedPlaces",
    async (req, reply) => {
      const userId = getUserId(req);
      const { target, places } = req.body;
      const targetId = "listId" in target ? target.listId : undefined;
      const targetName = "name" in target ? target.name : undefined;
      if (targetName !== undefined && (!targetName.trim() || targetName.trim().startsWith("$"))) {
        return reply
          .status(400)
          .send({ error: "Specify exactly one listId or non-reserved list name" });
      }
      for (const place of places) {
        if (place.fieldContributors === undefined) continue;
        const captured = parseSavedPlaceContributors(place.fieldContributors);
        if (captured === undefined)
          return reply.status(400).send({ error: "Invalid fieldContributors" });
        place.fieldContributors = captured;
      }
      const result = await db
        .transaction(async (tx) => {
          await lockSavedQuota(tx, userId);
          let listId = targetId;
          let name = targetName?.trim() || "";
          if (listId) {
            // Serialize imports into this list before reading membership and sort order.
            const [existing] = await tx
              .select({ id: savedList.id, name: savedList.name })
              .from(savedList)
              .where(and(eq(savedList.id, listId), eq(savedList.userId, userId)))
              .for("update");
            if (!existing) return null;
            name = existing.name;
          } else {
            if ((await countSavedLists(tx, userId)) >= MAX_SAVED_LISTS_PER_USER) {
              throw new SavedLimitError("SAVED_LIST_LIMIT");
            }
            const base = name;
            for (let suffix = 1; ; suffix++) {
              const ending = suffix === 1 ? "" : ` (${suffix})`;
              name = `${base.slice(0, 200 - ending.length).replace(/[\uD800-\uDBFF]$/, "")}${ending}`;
              const id = crypto.randomUUID();
              // ON CONFLICT permits concurrent imports and ordinary list creation to race safely.
              const inserted = await tx
                .insert(savedList)
                .values({ id, userId, name })
                .onConflictDoNothing({ target: [savedList.userId, savedList.name] })
                .returning({ id: savedList.id });
              if (inserted.length) {
                listId = id;
                break;
              }
            }
          }
          const existing = await tx
            .select({
              name: savedPlace.name,
              lat: savedPlace.lat,
              lng: savedPlace.lng,
              sortOrder: savedPlace.sortOrder,
            })
            .from(savedPlace)
            .where(eq(savedPlace.listId, listId));
          const cells = new Map<string, { lat: number; lng: number }[]>();
          const cellKey = (name: string, x: number, y: number) => JSON.stringify([name, x, y]);
          const remember = (place: { name: string; lat: number; lng: number }) => {
            const key = cellKey(
              place.name,
              Math.floor(place.lat / 1e-5),
              Math.floor(place.lng / 1e-5),
            );
            const cell = cells.get(key) || [];
            cell.push(place);
            cells.set(key, cell);
          };
          for (const place of existing) remember(place);
          let order = existing.reduce((max, place) => Math.max(max, place.sortOrder), -1);
          const rows: (typeof savedPlace.$inferInsert)[] = [];
          for (const place of places) {
            const x = Math.floor(place.lat / 1e-5);
            const y = Math.floor(place.lng / 1e-5);
            let duplicate = false;
            for (let dx = -1; dx <= 1 && !duplicate; dx++) {
              for (let dy = -1; dy <= 1 && !duplicate; dy++) {
                duplicate = (cells.get(cellKey(place.name, x + dx, y + dy)) || []).some(
                  (other) =>
                    Math.abs(other.lat - place.lat) <= 1e-5 &&
                    Math.abs(other.lng - place.lng) <= 1e-5,
                );
              }
            }
            if (duplicate) continue;
            remember(place);
            rows.push({
              ...place,
              id: crypto.randomUUID(),
              listId,
              placeId: null,
              sortOrder: ++order,
            });
          }
          // All or nothing: a batch that would pass the cap is refused whole, and
          // the throw also rolls back a list created for it above.
          if (
            rows.length &&
            (await countSavedPlaces(tx, userId)) + rows.length > MAX_SAVED_PLACES_PER_USER
          ) {
            throw new SavedLimitError("SAVED_PLACE_LIMIT");
          }
          if (rows.length) {
            await tx.insert(savedPlace).values(rows);
            await tx
              .update(savedList)
              .set({ updatedAt: new Date() })
              .where(eq(savedList.id, listId));
          }
          return {
            listId,
            name,
            imported: rows.length,
            skippedDuplicates: places.length - rows.length,
          };
        })
        .catch((error: unknown) => {
          if (error instanceof SavedLimitError) return error;
          throw error;
        });
      if (result instanceof SavedLimitError)
        return reply.status(409).send(conflictBody(result.code));
      if (!result) return reply.status(404).send({ error: "List not found" });
      return result;
    },
    // Throttle before the batch is validated or touches the database.
    { beforeValidation: savedImportLimit.preHandler() },
  );

  registerSavedRoute(fastify, "updateSavedList", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params;
    const body = req.body;

    // Protect only the actual system lists, including for legacy custom names.
    const existing = await db
      .select({ name: savedList.name })
      .from(savedList)
      .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
      .limit(1);

    if (existing.length === 0) {
      return reply.status(404).send({ error: "List not found" });
    }

    const isDefault = isSystemSavedList(existing[0].name);
    if (!isDefault && body.name?.startsWith("$")) {
      return reply.status(400).send({ error: "List names cannot start with $" });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined && !isDefault) updates.name = body.name;
    if (body.icon !== undefined && !isDefault) updates.icon = body.icon;
    if (body.isPrivate !== undefined) updates.isPrivate = body.isPrivate;
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }

    let result: { id: string }[];
    try {
      result = await db
        .update(savedList)
        .set(updates)
        .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
        .returning({ id: savedList.id });
    } catch (error) {
      rethrowUnlessNameTaken(error);
      return reply.status(409).send(conflictBody("SAVED_LIST_NAME_TAKEN"));
    }

    if (result.length === 0) {
      return reply.status(404).send({ error: "List not found" });
    }

    return { ok: true };
  });

  registerSavedRoute(fastify, "deleteSavedList", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params;

    const existing = await db
      .select({ name: savedList.name })
      .from(savedList)
      .where(and(eq(savedList.id, id), eq(savedList.userId, userId)))
      .limit(1);

    if (existing.length === 0) {
      return reply.status(404).send({ error: "List not found" });
    }

    if (isSystemSavedList(existing[0].name)) {
      return reply.status(400).send({ error: "Default lists cannot be deleted" });
    }

    await db.delete(savedList).where(and(eq(savedList.id, id), eq(savedList.userId, userId)));

    return { ok: true };
  });

  registerSavedRoute(fastify, "listSavedListPlaces", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params;

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
      .orderBy(...PLACE_ORDER);

    return { places };
  });

  registerSavedRoute(fastify, "exportSavedList", async (req, reply) => {
    const userId = getUserId(req);
    const { id } = req.params;
    const format = req.query.format;

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
      .orderBy(...PLACE_ORDER);

    const places: ExportPlace[] = rows.map((p) => ({
      fieldContributors: p.fieldContributors ?? undefined,
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
  });

  registerSavedRoute(fastify, "createSavedPlace", async (req, reply) => {
    const userId = getUserId(req);

    const { id: listId } = req.params;
    const body = req.body;

    if (!body.name || body.lat === undefined || body.lng === undefined) {
      return reply.status(400).send({ error: "name, lat, and lng are required" });
    }

    const captured =
      body.fieldContributors === undefined
        ? undefined
        : parseSavedPlaceContributors(body.fieldContributors);
    if (body.fieldContributors !== undefined && captured === undefined)
      return reply.status(400).send({ error: "Invalid fieldContributors" });
    const id = crypto.randomUUID();
    const outcome = await db.transaction(async (tx) => {
      await lockSavedQuota(tx, userId);
      const list = await tx
        .select({ id: savedList.id })
        .from(savedList)
        .where(and(eq(savedList.id, listId), eq(savedList.userId, userId)))
        .limit(1);
      if (list.length === 0) return "missing" as const;
      if ((await countSavedPlaces(tx, userId)) >= MAX_SAVED_PLACES_PER_USER) {
        return "limit" as const;
      }
      await tx.insert(savedPlace).values({
        id,
        listId,
        name: body.name,
        address: body.address ?? null,
        lat: body.lat,
        lng: body.lng,
        placeId: body.placeId ?? null,
        fieldContributors: captured ?? null,
        note: body.note ?? null,
      });
      return "created" as const;
    });
    if (outcome === "missing") return reply.status(404).send({ error: "List not found" });
    if (outcome === "limit") return reply.status(409).send(conflictBody("SAVED_PLACE_LIMIT"));

    return {
      id,
      listId,
      name: body.name,
      address: body.address ?? null,
      lat: body.lat,
      lng: body.lng,
      placeId: body.placeId ?? null,
      note: body.note ?? null,
      ...(captured === undefined ? {} : { fieldContributors: captured }),
    };
  });

  registerSavedRoute(fastify, "updateSavedPlace", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params;

    const existing = await db
      .select({ placeId: savedPlace.id, listUserId: savedList.userId })
      .from(savedPlace)
      .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
      .where(eq(savedPlace.id, id))
      .limit(1);

    if (existing.length === 0 || existing[0].listUserId !== userId) {
      return reply.status(404).send({ error: "Place not found" });
    }

    const body = req.body;

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.address !== undefined) updates.address = body.address;
    if (body.lat !== undefined) updates.lat = body.lat;
    if (body.lng !== undefined) updates.lng = body.lng;
    // Evaluate against the current row atomically: two edits cannot restore a stale receipt.
    let capture = sql`${savedPlace.fieldContributors}`;
    for (const field of SAVED_PLACE_FIELDS) {
      if (body[field] === undefined) continue;
      capture = sql`CASE WHEN ${savedPlace[field]} IS DISTINCT FROM ${body[field]} AND ${savedPlace.fieldContributors} IS NOT NULL THEN jsonb_set(${capture}, ARRAY[${field}]::text[], '[]'::jsonb) ELSE ${capture} END`;
    }
    if (SAVED_PLACE_FIELDS.some((field) => body[field] !== undefined))
      updates.fieldContributors = capture;
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
  });

  registerSavedRoute(fastify, "deleteSavedPlace", async (req, reply) => {
    const userId = getUserId(req);

    const { id } = req.params;

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

  registerSavedRoute(fastify, "listSavedLabels", async (req, _reply) => {
    const userId = getUserId(req);

    const labels = await db
      .select({
        id: labeledPlace.id,
        label: labeledPlace.label,
        icon: labeledPlace.icon,
        name: labeledPlace.name,
        address: labeledPlace.address,
        lat: labeledPlace.lat,
        lng: labeledPlace.lng,
        placeId: labeledPlace.placeId,
        fieldContributors: labeledPlace.fieldContributors,
      })
      .from(labeledPlace)
      .where(eq(labeledPlace.userId, userId));

    return { labels };
  });

  registerSavedRoute(fastify, "writeSavedLabel", async (req, reply) => {
    const userId = getUserId(req);

    const { label } = req.params;
    const body = req.body;

    const captured =
      body.fieldContributors === undefined
        ? undefined
        : parseSavedPlaceContributors(body.fieldContributors);
    if (body.fieldContributors !== undefined && captured === undefined)
      return reply.status(400).send({ error: "Invalid fieldContributors" });
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
          fieldContributors: captured ?? null,
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
      fieldContributors: captured ?? null,
      icon: body.icon ?? null,
    });

    return { id, label };
  });

  registerSavedRoute(fastify, "deleteSavedLabel", async (req, reply) => {
    const userId = getUserId(req);

    const { label } = req.params;

    const result = await db
      .delete(labeledPlace)
      .where(and(eq(labeledPlace.userId, userId), eq(labeledPlace.label, label)))
      .returning({ id: labeledPlace.id });

    if (result.length === 0) {
      return reply.status(404).send({ error: "Label not found" });
    }

    return { ok: true };
  });

  registerSavedRoute(fastify, "checkSavedPlace", async (req, reply) => {
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
