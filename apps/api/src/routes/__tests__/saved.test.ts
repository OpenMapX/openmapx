import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test/app.js";
import { mockRequireAuth } from "../../test/auth.js";
import { createDbMock, type DbMock } from "../../test/db.js";

const USER_ID = "user-A";

const authMock = mockRequireAuth(USER_ID);
const dbMock: DbMock = createDbMock();

vi.mock("../../utils/require-auth.js", () => authMock);
vi.mock("../../db/index.js", () => ({ db: dbMock.db }));

// Distinctive column placeholders so the serialized drizzle where-clause embeds
// the column name verbatim — that lets a test assert which column a query is
// constrained on (e.g. `saved_list.user_id = <userId>`), which is the whole
// point of the cross-user isolation checks below.
vi.mock("../../db/schema.js", () => ({
  savedList: {
    id: "saved_list.id",
    userId: "saved_list.user_id",
    name: "saved_list.name",
    icon: "saved_list.icon",
    isPrivate: "saved_list.is_private",
    sortOrder: "saved_list.sort_order",
    createdAt: "saved_list.created_at",
    updatedAt: "saved_list.updated_at",
  },
  savedPlace: {
    id: "saved_place.id",
    listId: "saved_place.list_id",
    sortOrder: "saved_place.sort_order",
    name: "saved_place.name",
    lat: "saved_place.lat",
    lng: "saved_place.lng",
    address: "saved_place.address",
    note: "saved_place.note",
    placeId: "saved_place.place_id",
  },
  labeledPlace: {
    id: "labeled_place.id",
    userId: "labeled_place.user_id",
    label: "labeled_place.label",
    name: "labeled_place.name",
    address: "labeled_place.address",
    lat: "labeled_place.lat",
    lng: "labeled_place.lng",
    placeId: "labeled_place.place_id",
    icon: "labeled_place.icon",
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { savedRoute } = await import("../saved.js");
  app = await buildTestApp(savedRoute, { prefix: "/api" });
});

afterEach(async () => {
  await app.close();
  authMock.requireAuthHook.mockReset();
  authMock.getUserId.mockReset();
  authMock.requireAuth.mockReset();
  // Restore the default authenticated behaviour for the next test.
  authMock.requireAuthHook.mockImplementation(async (request) => {
    (request as { userId?: string }).userId = USER_ID;
  });
  authMock.getUserId.mockImplementation(() => USER_ID);
  authMock.requireAuth.mockImplementation(async () => USER_ID);
  dbMock.db.select.mockClear();
  dbMock.db.insert.mockClear();
  dbMock.db.update.mockClear();
  dbMock.db.delete.mockClear();
});

/** Serialize every arg passed to the `.where()` of the Nth select chain. */
function selectWhereArgs(callIndex: number): string {
  const chain = dbMock.db.select.mock.results[callIndex]?.value as {
    where: { mock: { calls: unknown[][] } };
  };
  const calls = chain.where.mock.calls;
  return JSON.stringify(calls, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function lastWhereArgs(op: "select" | "update" | "delete"): string {
  const results = dbMock.db[op].mock.results;
  const chain = results[results.length - 1]?.value as {
    where: { mock: { calls: unknown[][] } };
  };
  const calls = chain.where.mock.calls;
  return JSON.stringify(calls, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

describe("saved routes — authentication", () => {
  it("returns 401 when the auth guard rejects (unauthenticated)", async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    authMock.requireAuthHook.mockImplementation(async () => {
      throw httpError(401, "Authentication required");
    });

    const res = await app.inject({ method: "GET", url: "/api/saved/lists" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Authentication required" });
    // No DB access should occur once auth fails.
    expect(dbMock.db.select).not.toHaveBeenCalled();
  });

  it("401 surfaces for a write route too (preHandler runs before the handler)", async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    authMock.requireAuthHook.mockImplementation(async () => {
      throw httpError(401, "Authentication required");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists",
      payload: { name: "Trip" },
    });

    expect(res.statusCode).toBe(401);
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});

describe("GET /api/saved/lists", () => {
  it("returns the caller's lists, scoped to their userId", async () => {
    dbMock.queueSelect([
      {
        id: "list-1",
        name: "$favorites",
        icon: "heart",
        isPrivate: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        placeCount: 2,
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/saved/lists" });

    expect(res.statusCode).toBe(200);
    expect(res.json().lists).toHaveLength(1);
    expect(res.json().lists[0].id).toBe("list-1");
    // The list query must be filtered by the authenticated user's id.
    const where = selectWhereArgs(0);
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("seeds default lists for a first-time user when none exist", async () => {
    dbMock.queueSelect([]); // no existing lists

    const res = await app.inject({ method: "GET", url: "/api/saved/lists" });

    expect(res.statusCode).toBe(200);
    const names = res.json().lists.map((l: { name: string }) => l.name);
    expect(names).toEqual(["$favorites", "$wantToGo", "$starredPlaces"]);
    expect(dbMock.db.insert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/saved/lists", () => {
  it("creates a list owned by the authenticated user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists",
      payload: { name: "Weekend Trip", icon: "car" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("Weekend Trip");
    expect(body.icon).toBe("car");
    expect(body.isPrivate).toBe(true);
    expect(body.id).toBeTruthy();

    // The inserted row must carry the caller's userId — never a client value.
    expect(dbMock.db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = (
      dbMock.db.insert.mock.results[0].value as { values: { mock: { calls: unknown[][] } } }
    ).values.mock.calls[0][0] as { userId: string };
    expect(insertedValues.userId).toBe(USER_ID);
  });

  it("rejects a body missing the required name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists",
      payload: { icon: "car" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/saved/lists/:id", () => {
  it("updates a list owned by the caller and scopes the update by userId", async () => {
    dbMock.queueSelect([{ name: "My Places" }]); // ownership lookup
    dbMock.queueUpdate([{ id: "list-9" }]); // returning() rows

    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/list-9",
      payload: { name: "Renamed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // The UPDATE must be constrained to the owning user, not just the id.
    const where = lastWhereArgs("update");
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("404s when the list belongs to another user (userId-scoped lookup returns [])", async () => {
    dbMock.queueSelect([]); // ownership lookup finds nothing for this user

    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/someone-elses-list",
      payload: { name: "Hijack" },
    });

    expect(res.statusCode).toBe(404);
    // Critically: no UPDATE is issued when ownership cannot be confirmed.
    expect(dbMock.db.update).not.toHaveBeenCalled();
    const where = selectWhereArgs(0);
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("does not rename a default ($) list but still applies allowed fields", async () => {
    dbMock.queueSelect([{ name: "$favorites" }]);
    dbMock.queueUpdate([{ id: "list-1" }]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/list-1",
      payload: { name: "Hacked", sortOrder: 5 },
    });

    expect(res.statusCode).toBe(200);
    const setArg = (
      dbMock.db.update.mock.results[0].value as { set: { mock: { calls: unknown[][] } } }
    ).set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty("name");
    expect(setArg.sortOrder).toBe(5);
  });
});

describe("DELETE /api/saved/lists/:id", () => {
  it("deletes a user-owned non-default list, scoped by userId", async () => {
    dbMock.queueSelect([{ name: "Trip" }]);

    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/list-7" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const where = lastWhereArgs("delete");
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("404s and issues no delete when the list isn't owned by the caller", async () => {
    dbMock.queueSelect([]);

    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/foreign" });

    expect(res.statusCode).toBe(404);
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a default ($) list with 400", async () => {
    dbMock.queueSelect([{ name: "$favorites" }]);

    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/list-1" });

    expect(res.statusCode).toBe(400);
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });
});

describe("GET /api/saved/lists/:id/places", () => {
  it("returns a list's places after confirming ownership", async () => {
    dbMock.queueSelect([{ id: "list-1" }]); // ownership lookup
    dbMock.queueSelect([{ id: "pl-1", listId: "list-1", name: "Gate" }]); // places

    const res = await app.inject({ method: "GET", url: "/api/saved/lists/list-1/places" });

    expect(res.statusCode).toBe(200);
    expect(res.json().places).toHaveLength(1);
    expect(res.json().places[0].id).toBe("pl-1");
    // Ownership lookup must filter by userId.
    const where = selectWhereArgs(0);
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("404s for a list owned by another user without reading its places", async () => {
    dbMock.queueSelect([]); // ownership lookup returns nothing

    const res = await app.inject({ method: "GET", url: "/api/saved/lists/foreign/places" });

    expect(res.statusCode).toBe(404);
    // Only the ownership lookup ran; the places query must not be reached.
    expect(dbMock.db.select).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/saved/lists/:id/places", () => {
  it("adds a place after confirming the list is owned by the caller", async () => {
    dbMock.queueSelect([{ id: "list-1" }]); // ownership lookup

    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists/list-1/places",
      payload: { name: "Brandenburg Gate", lat: 52.5163, lng: 13.3777 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.listId).toBe("list-1");
    expect(body.name).toBe("Brandenburg Gate");
    expect(body.lat).toBe(52.5163);
    expect(dbMock.db.insert).toHaveBeenCalledTimes(1);
    const where = selectWhereArgs(0);
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("404s and inserts nothing when adding to another user's list", async () => {
    dbMock.queueSelect([]); // ownership lookup returns nothing

    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists/foreign/places",
      payload: { name: "X", lat: 1, lng: 2 },
    });

    expect(res.statusCode).toBe(404);
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/saved/places/:id", () => {
  it("updates a place whose list belongs to the caller", async () => {
    dbMock.queueSelect([{ placeId: "pl-1", listUserId: USER_ID }]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/places/pl-1",
      payload: { note: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // The UPDATE itself re-scopes to lists owned by the caller via a subquery.
    const where = lastWhereArgs("update");
    expect(where).toContain(USER_ID);
  });

  it("404s and issues no update when the place's list is owned by another user", async () => {
    // Ownership row exists but is owned by someone else.
    dbMock.queueSelect([{ placeId: "pl-1", listUserId: "user-B" }]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/places/pl-1",
      payload: { note: "Hijack" },
    });

    expect(res.statusCode).toBe(404);
    expect(dbMock.db.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/saved/places/:id", () => {
  it("deletes a place whose list belongs to the caller", async () => {
    dbMock.queueSelect([{ placeId: "pl-1", listUserId: USER_ID }]);

    const res = await app.inject({ method: "DELETE", url: "/api/saved/places/pl-1" });

    expect(res.statusCode).toBe(200);
    const where = lastWhereArgs("delete");
    expect(where).toContain(USER_ID);
  });

  it("404s and issues no delete when the place is owned by another user", async () => {
    dbMock.queueSelect([{ placeId: "pl-1", listUserId: "user-B" }]);

    const res = await app.inject({ method: "DELETE", url: "/api/saved/places/pl-1" });

    expect(res.statusCode).toBe(404);
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });
});

describe("GET /api/saved/labels", () => {
  it("returns only the caller's labels", async () => {
    dbMock.queueSelect([{ id: "lab-1", userId: USER_ID, label: "home" }]);

    const res = await app.inject({ method: "GET", url: "/api/saved/labels" });

    expect(res.statusCode).toBe(200);
    expect(res.json().labels).toHaveLength(1);
    const where = selectWhereArgs(0);
    expect(where).toContain("labeled_place.user_id");
    expect(where).toContain(USER_ID);
  });
});

describe("PUT /api/saved/labels/:label", () => {
  it("creates a new label scoped to the caller when none exists", async () => {
    dbMock.queueSelect([]); // existing lookup returns nothing

    const res = await app.inject({
      method: "PUT",
      url: "/api/saved/labels/home",
      payload: { name: "Home", lat: 52.5, lng: 13.4 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("home");
    expect(dbMock.db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = (
      dbMock.db.insert.mock.results[0].value as { values: { mock: { calls: unknown[][] } } }
    ).values.mock.calls[0][0] as { userId: string };
    expect(insertedValues.userId).toBe(USER_ID);
    // The existence lookup is scoped to the caller.
    const where = selectWhereArgs(0);
    expect(where).toContain("labeled_place.user_id");
    expect(where).toContain(USER_ID);
  });

  it("updates an existing label instead of inserting a duplicate", async () => {
    dbMock.queueSelect([{ id: "lab-1" }]); // existing label found

    const res = await app.inject({
      method: "PUT",
      url: "/api/saved/labels/home",
      payload: { name: "Home 2", lat: 1, lng: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("lab-1");
    expect(dbMock.db.update).toHaveBeenCalledTimes(1);
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/saved/labels/:label", () => {
  it("deletes a label scoped by userId", async () => {
    dbMock.queueDelete([{ id: "lab-1" }]); // returning() rows

    const res = await app.inject({ method: "DELETE", url: "/api/saved/labels/home" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const where = lastWhereArgs("delete");
    expect(where).toContain("labeled_place.user_id");
    expect(where).toContain(USER_ID);
  });

  it("404s when no userId-scoped label matched", async () => {
    dbMock.queueDelete([]); // nothing deleted for this user

    const res = await app.inject({ method: "DELETE", url: "/api/saved/labels/missing" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/saved/check", () => {
  it("returns the list ids holding a placeId, scoped to the caller", async () => {
    dbMock.queueSelect([{ listId: "list-1" }, { listId: "list-2" }]);

    const res = await app.inject({ method: "GET", url: "/api/saved/check?placeId=p-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().listIds).toEqual(["list-1", "list-2"]);
    const where = selectWhereArgs(0);
    expect(where).toContain("saved_list.user_id");
    expect(where).toContain(USER_ID);
  });

  it("400s when placeId is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/saved/check" });
    expect(res.statusCode).toBe(400);
  });
});
