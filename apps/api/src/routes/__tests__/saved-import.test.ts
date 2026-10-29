import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestApp } from "../../test/app";
import { mockRequireAuth } from "../../test/auth";
import { makeQueryChain } from "../../test/db";

const authMock = mockRequireAuth("user-1");
vi.mock("../../utils/require-auth", () => authMock);
const state = vi.hoisted(() => ({
  queue: [] as unknown[][],
  inserted: [] as { table: unknown; rows: unknown }[],
  transactions: 0,
  failInsert: false,
}));
function chain(table?: unknown) {
  const rows = state.queue.shift() || [];
  const builder = makeQueryChain(rows);
  builder.values = (values: unknown) => {
    state.inserted.push({ table, rows: values });
    if (state.failInsert && table === "places") throw new Error("Insert failed");
    return builder;
  };
  return builder;
}
vi.mock("../../db/index", () => {
  const db = {
    select: () => chain(),
    insert: (table: unknown) => chain(table),
    update: () => chain(),
    transaction: async (fn: (tx: unknown) => unknown) => {
      state.transactions++;
      return fn(db);
    },
  };
  return { db };
});
vi.mock("../../db/schema", () => ({
  savedList: { id: "id", userId: "userId", name: "name" },
  savedPlace: "places",
  labeledPlace: {},
}));
let app: FastifyInstance;
const point = { name: "Cafe", lat: 52, lng: 13, note: "A note" };
beforeAll(async () => {
  const { savedRoute } = await import("../saved");
  app = await buildTestApp(savedRoute, { prefix: "/api" });
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  state.queue = [];
  state.inserted = [];
  state.transactions = 0;
  state.failInsert = false;
});
const request = (target: unknown, places: unknown[] = [point]) =>
  app.inject({ method: "POST", url: "/api/saved/lists/import", payload: { target, places } });
describe("saved list imports", () => {
  it("requires a session before starting a transaction", async () => {
    authMock.requireAuthHook.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    expect((await request({ listId: "list-1" })).statusCode).toBe(401);
    expect(state.transactions).toBe(0);
  });
  it("imports into an owned system list, skips near duplicates, and appends sort order", async () => {
    state.queue.push(
      [{ id: "list-1", name: "$favorites" }],
      [{ name: "Cafe", lat: 52.000009, lng: 13.000009, sortOrder: 8 }],
      [],
      [],
    );
    const response = await request({ listId: "list-1" }, [
      point,
      { ...point, name: "New" },
      { ...point, name: "New", lat: 52.000001 },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      listId: "list-1",
      name: "$favorites",
      imported: 1,
      skippedDuplicates: 2,
    });
    expect(state.transactions).toBe(1);
    expect(state.inserted[0].rows).toEqual([
      expect.objectContaining({ name: "New", sortOrder: 9, placeId: null, listId: "list-1" }),
    ]);
  });
  it("stores validated field captures without changing duplicate handling", async () => {
    const fieldContributors = { lat: [{ sourceId: "geo", name: "Geocoder" }], lng: [] };
    state.queue.push([{ id: "list-1", name: "Trip" }], [], [], []);
    expect(
      (await request({ listId: "list-1" }, [{ ...point, fieldContributors }])).statusCode,
    ).toBe(200);
    expect(state.inserted[0].rows).toEqual([expect.objectContaining({ fieldContributors })]);
  });
  it.each([{ phone: [] }, { lat: [{}] }, { lng: "bad" }])(
    "rejects an entire batch with invalid captures %j",
    async (fieldContributors) => {
      const response = await request({ name: "Trip" }, [point, { ...point, fieldContributors }]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Invalid fieldContributors" });
      expect(state.transactions).toBe(0);
      expect(state.inserted).toHaveLength(0);
    },
  );
  it("suffixes a colliding list name without exceeding 200 characters", async () => {
    state.queue.push([], [{ id: "new-list" }], [], [], []);
    const response = await request({ name: "a".repeat(200) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: `${"a".repeat(196)} (2)`, imported: 1 });
    expect(state.inserted).toHaveLength(3);
  });
  it("returns 404 for a missing or other user's list", async () => {
    expect((await request({ listId: "not-mine" })).statusCode).toBe(404);
    expect(state.inserted).toHaveLength(0);
  });
  it.each([{}, { listId: "a", name: "b" }, { name: "$favorites" }, { name: "" }, { name: "   " }])(
    "rejects an invalid target %j",
    async (target) => {
      expect((await request(target)).statusCode).toBe(400);
      expect(state.inserted).toHaveLength(0);
    },
  );
  it.each(
    [
      [],
      [{ ...point, lat: 91 }],
      [{ ...point, lng: -181 }],
      [{ ...point, name: "" }],
      [{ ...point, note: "a".repeat(2001) }],
      Array.from({ length: 2001 }, () => point),
    ].map((places) => ({ places })),
  )("rejects invalid place batches", async ({ places }) =>
    expect((await request({ name: "Trip" }, places)).statusCode).toBe(400),
  );
  it("accepts 2000 places with full notes beyond Fastify's default body limit", async () => {
    state.queue.push([{ id: "list-1", name: "Trip" }], [], [], []);
    const places = Array.from({ length: 2000 }, (_, index) => ({
      ...point,
      name: `Place ${index}`,
      note: "a".repeat(2000),
    }));
    const response = await request({ listId: "list-1" }, places);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ imported: 2000, skippedDuplicates: 0 });
  });
  it("does not report success when a transactional insert fails", async () => {
    state.queue.push([{ id: "list-1", name: "Trip" }], []);
    state.failInsert = true;
    expect((await request({ listId: "list-1" })).statusCode).toBe(500);
  });
});
