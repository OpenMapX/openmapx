import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

const queue: unknown[][] = [];
function prime(...results: unknown[][]) {
  queue.length = 0;
  queue.push(...results);
}

function makeChain() {
  const result = queue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "limit",
    "orderBy",
    "innerJoin",
    "set",
    "values",
    "onConflictDoNothing",
    "returning",
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("../../db/index.js", () => ({
  db: {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  },
}));

vi.mock("../../db/schema.js", () => ({
  savedList: {
    id: "id",
    userId: "userId",
    name: "name",
    icon: "icon",
    isPrivate: "isPrivate",
    sortOrder: "sortOrder",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  savedPlace: {
    id: "id",
    listId: "listId",
    sortOrder: "sortOrder",
    placeId: "placeId",
    name: "name",
    address: "address",
    lat: "lat",
    lng: "lng",
    note: "note",
    createdAt: "createdAt",
  },
  labeledPlace: { id: "id", userId: "userId", label: "label", name: "name" },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { savedRoute } = await import("../saved.js");
  app = Fastify();
  await app.register(savedRoute, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  queue.length = 0;
});

describe("saved lists", () => {
  it("returns existing lists", async () => {
    prime([
      {
        id: "list-1",
        name: "Trip",
        icon: null,
        isPrivate: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/saved/lists" });
    expect(res.statusCode).toBe(200);
    expect(res.json().lists).toHaveLength(1);
  });

  it("seeds 3 default lists when the user has none", async () => {
    prime([]); // no existing lists; the subsequent insert result is unused
    const res = await app.inject({ method: "GET", url: "/api/saved/lists" });
    expect(res.statusCode).toBe(200);
    expect(res.json().lists).toHaveLength(3);
  });

  it("404s PATCH on a list the user does not own", async () => {
    prime([]); // ownership select returns nothing
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/x",
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a default-list rename (name is ignored, leaving no updates)", async () => {
    prime([{ name: "$favorites" }]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/list-1",
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates a non-default list", async () => {
    prime([{ name: "Trip" }], [{ id: "list-1" }]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/list-1",
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s deleting a default list", async () => {
    prime([{ name: "$favorites" }]);
    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/list-1" });
    expect(res.statusCode).toBe(400);
  });

  it("deletes a non-default owned list", async () => {
    prime([{ name: "Trip" }]); // ownership select; delete result unused
    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/list-1" });
    expect(res.statusCode).toBe(200);
  });

  it("404s deleting a list the user does not own", async () => {
    prime([]);
    const res = await app.inject({ method: "DELETE", url: "/api/saved/lists/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("saved places (ownership / IDOR)", () => {
  it("404s adding a place to a list the user does not own", async () => {
    prime([]); // list ownership select empty
    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists/list-1/places",
      payload: { name: "Cafe", lat: 52.5, lng: 13.4 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("adds a place to an owned list", async () => {
    prime([{ id: "list-1" }]); // ownership ok; insert result unused
    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists/list-1/places",
      payload: { name: "Cafe", lat: 52.5, lng: 13.4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeDefined();
  });

  it("404s PATCH on a place owned by another user (IDOR guard)", async () => {
    prime([{ placeId: "pl-1", listUserId: "other-user" }]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/places/pl-1",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCHes a place the user owns", async () => {
    prime([{ placeId: "pl-1", listUserId: "user-1" }], []);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/places/pl-1",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("404s DELETE on a place owned by another user (IDOR guard)", async () => {
    prime([{ placeId: "pl-1", listUserId: "other-user" }]);
    const res = await app.inject({ method: "DELETE", url: "/api/saved/places/pl-1" });
    expect(res.statusCode).toBe(404);
  });

  it("DELETEs a place the user owns", async () => {
    prime([{ placeId: "pl-1", listUserId: "user-1" }]);
    const res = await app.inject({ method: "DELETE", url: "/api/saved/places/pl-1" });
    expect(res.statusCode).toBe(200);
  });
});

describe("labels and check", () => {
  it("404s DELETE of a non-existent label", async () => {
    prime([]); // returning() empty
    const res = await app.inject({ method: "DELETE", url: "/api/saved/labels/home" });
    expect(res.statusCode).toBe(404);
  });

  it("400s /saved/check without a placeId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/saved/check" });
    expect(res.statusCode).toBe(400);
  });

  it("returns matching listIds from /saved/check", async () => {
    prime([{ listId: "list-1" }]);
    const res = await app.inject({ method: "GET", url: "/api/saved/check?placeId=p-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().listIds).toEqual(["list-1"]);
  });
});
