import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

const queue: unknown[][] = [];
const LEGACY_CUSTOM_LIST = "$trip";
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
  await app?.close();
});

beforeEach(() => {
  queue.length = 0;
});

describe("saved lists", () => {
  it("creates ordinary custom names, including a dollar sign inside the name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/saved/lists",
      payload: { name: "Trip $2026" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Trip $2026");
  });

  it.each(["$trip", "$favorites", "$wantToGo", "$starredPlaces"])(
    "rejects reserved custom name %s on creation",
    async (name) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/saved/lists",
        payload: { name },
      });
      expect(created.statusCode).toBe(400);
    },
  );

  it.each(["$trip", "$favorites", "$wantToGo", "$starredPlaces"])(
    "rejects reserved custom name %s on rename",
    async (name) => {
      prime([{ name: "Trip" }], [{ id: "list-1" }]);
      const renamed = await app.inject({
        method: "PATCH",
        url: "/api/saved/lists/list-1",
        payload: { name },
      });
      expect(renamed.statusCode).toBe(400);
    },
  );

  it("allows a legacy custom dollar-prefixed list to be renamed, updated and deleted", async () => {
    for (const payload of [{ name: "Trip" }, { icon: "flag", isPrivate: false }]) {
      prime([{ name: LEGACY_CUSTOM_LIST }], [{ id: "list-1" }]);
      const res = await app.inject({ method: "PATCH", url: "/api/saved/lists/list-1", payload });
      expect(res.statusCode).toBe(200);
    }
    prime([{ name: LEGACY_CUSTOM_LIST }]);
    const deleted = await app.inject({ method: "DELETE", url: "/api/saved/lists/list-1" });
    expect(deleted.statusCode).toBe(200);
  });

  it.each(["$favorites", "$wantToGo", "$starredPlaces"])(
    "keeps system list %s protected",
    async (name) => {
      prime([{ name }]);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/saved/lists/list-1",
            payload: { name: "Trip", icon: "flag" },
          })
        ).statusCode,
      ).toBe(400);
      prime([{ name }]);
      expect(
        (await app.inject({ method: "DELETE", url: "/api/saved/lists/list-1" })).statusCode,
      ).toBe(400);
      prime([{ name }], [{ id: "list-1" }]);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/saved/lists/list-1",
            payload: { isPrivate: false, sortOrder: 4 },
          })
        ).statusCode,
      ).toBe(200);
    },
  );

  it("400s a default-list rename (name is ignored, leaving no updates)", async () => {
    prime([{ name: "$favorites" }]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/saved/lists/list-1",
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(400);
  });
});

it("serializes exact saved captures and rejects malformed or unbounded public field maps", async () => {
  const fieldContributors = {
    name: [{ sourceId: "original", name: "Original publisher", attributionText: "Original terms" }],
    address: [],
    lat: [],
    lng: [],
  };
  prime([{ id: "list-1" }]);
  const saved = await app.inject({
    method: "POST",
    url: "/api/saved/lists/list-1/places",
    payload: { name: "Name", address: null, lat: 50, lng: 8, fieldContributors },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().fieldContributors).toEqual(fieldContributors);
  expect(saved.json().address).toBeNull();
  for (const capture of [
    { name: [{}] },
    { phone: [] },
    { name: Array(33).fill(fieldContributors.name[0]) },
    { name: [{ ...fieldContributors.name[0], notes: "x".repeat(65536) }] },
  ]) {
    prime([{ id: "list-1" }]);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/saved/lists/list-1/places",
      payload: { name: "Name", lat: 50, lng: 8, fieldContributors: capture },
    });
    expect(invalid.statusCode).toBe(400);
  }
});
