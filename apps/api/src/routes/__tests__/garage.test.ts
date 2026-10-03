import { PgDialect } from "drizzle-orm/pg-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "../../db/schema";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

const queue: unknown[][] = [];
function prime(...results: unknown[][]) {
  queue.length = 0;
  queue.push(...results);
}

const predicates: { operation: string; sql: string; params: unknown[] }[] = [];
const dialect = new PgDialect();

function makeChain(operation: string, lock = false) {
  const result = lock ? [{ id: "user-1" }] : (queue.shift() ?? []);
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "for",
    "where",
    "limit",
    "orderBy",
    "innerJoin",
    "set",
    "values",
    "onConflictDoNothing",
    "onConflictDoUpdate",
    "returning",
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.where = (predicate: Parameters<typeof dialect.sqlToQuery>[0]) => {
    predicates.push({ operation, ...dialect.sqlToQuery(predicate) });
    return chain;
  };
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

const fakeDb = {
  select: (fields?: Record<string, unknown>) => makeChain("select", fields?.id === user.id),
  insert: () => makeChain("insert"),
  update: () => makeChain("update"),
  delete: () => makeChain("delete"),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

vi.mock("../../db/index.js", () => ({ db: fakeDb }));

let app: FastifyInstance;

beforeAll(async () => {
  const { garageRoute } = await import("../garage.js");
  app = Fastify();
  await app.register(garageRoute, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  queue.length = 0;
  predicates.length = 0;
});

const VEHICLE_BODY = {
  name: "Blue Golf",
  kind: "car",
  powertrain: "petrol",
  fuelConsumptionLPer100Km: 6.4,
};

describe("vehicles", () => {
  it("lists the caller's vehicles and never caches the response", async () => {
    prime([{ id: "v1", name: "Blue Golf" }]);
    const res = await app.inject({ method: "GET", url: "/api/vehicles" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vehicles).toHaveLength(1);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(predicates[0].sql).toContain("user_id");
    expect(predicates[0].params).toEqual(["user-1"]);
  });

  it("creates a vehicle and makes the first one the default", async () => {
    prime([{ count: 0 }]);
    const res = await app.inject({ method: "POST", url: "/api/vehicles", payload: VEHICLE_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json().isDefault).toBe(true);
  });

  it("rejects a vehicle that fails shared validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { ...VEHICLE_BODY, powertrain: "electric", ev: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to exceed the per-user cap", async () => {
    prime([{ count: 12 }]);
    const res = await app.inject({ method: "POST", url: "/api/vehicles", payload: VEHICLE_BODY });
    expect(res.statusCode).toBe(409);
  });

  it("404s PATCH on a vehicle the caller does not own", async () => {
    prime([]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/vehicles/other",
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(404);
    const lookup = predicates.at(-1);
    expect(lookup?.sql).toContain("user_id");
    expect(lookup?.params).toContain("user-1");
    expect(lookup?.params).toEqual(["other", "user-1"]);
  });

  it("404s DELETE on a vehicle the caller does not own", async () => {
    prime([]);
    const res = await app.inject({ method: "DELETE", url: "/api/vehicles/other" });
    expect(res.statusCode).toBe(404);
    const lookup = predicates.at(-1);
    expect(lookup?.sql).toContain("user_id");
    expect(lookup?.params).toContain("user-1");
    expect(lookup?.params).toEqual(["other", "user-1"]);
  });
});

describe("parking", () => {
  it("lists parked records without caching them", async () => {
    prime([{ id: "p1", vehicleId: null, lat: 51.5, lng: 6.6 }]);
    const res = await app.inject({ method: "GET", url: "/api/parking" });
    expect(res.statusCode).toBe(200);
    expect(res.json().parked).toHaveLength(1);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(predicates[0].sql).toContain("user_id");
    expect(predicates[0].params).toEqual(["user-1"]);
  });

  it("upserts the unassigned record", async () => {
    prime([{ id: "p1", vehicleId: null, lat: 51.5, lng: 6.6 }]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/parking",
      payload: { vehicleId: null, lat: 51.5, lng: 6.6, source: "manual" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("p1");
  });

  it("404s when the vehicleId is not the caller's", async () => {
    prime([]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/parking",
      payload: { vehicleId: "someone-elses", lat: 51.5, lng: 6.6, source: "manual" },
    });
    expect(res.statusCode).toBe(404);
    const lookup = predicates.at(-1);
    expect(lookup?.sql).toContain("user_id");
    expect(lookup?.params).toContain("user-1");
    expect(lookup?.params).toEqual(["someone-elses", "user-1"]);
  });

  it("rejects coordinates outside the world", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/parking",
      payload: { vehicleId: null, lat: 91, lng: 6.6, source: "manual" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s PATCH on a record the caller does not own", async () => {
    prime([]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/parking/other",
      payload: { note: "Level 3" },
    });
    expect(res.statusCode).toBe(404);
    const lookup = predicates.at(-1);
    expect(lookup?.sql).toContain("user_id");
    expect(lookup?.params).toContain("user-1");
    expect(lookup?.params).toEqual(["other", "user-1"]);
  });

  it("404s DELETE on a record the caller does not own", async () => {
    prime([]);
    const res = await app.inject({ method: "DELETE", url: "/api/parking/other" });
    expect(res.statusCode).toBe(404);
    const lookup = predicates.at(-1);
    expect(lookup?.sql).toContain("user_id");
    expect(lookup?.params).toContain("user-1");
    expect(lookup?.params).toEqual(["other", "user-1"]);
  });
});

// Removing an ownership clause from a successful write must fail these checks too.
describe("successful write ownership predicates", () => {
  it("scopes default resets and vehicle updates to the caller", async () => {
    prime([{ id: "v1", ...VEHICLE_BODY, isDefault: false }], [], []);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/vehicles/v1",
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    const writes = predicates.filter((p) => p.operation === "update");
    expect(writes).toHaveLength(2);
    for (const predicate of writes) {
      expect(predicate.sql).toContain("user_id");
      expect(predicate.params).toContain("user-1");
      expect(predicate.params).toContain("v1");
    }
  });

  it("scopes creation default resets to the caller", async () => {
    prime([{ count: 1 }], [], []);
    const res = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { ...VEHICLE_BODY, isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    const reset = predicates.find((p) => p.operation === "update");
    expect(reset?.sql).toContain("user_id");
    expect(reset?.params).toEqual(["user-1"]);
  });

  it("scopes parking updates and deletions to the caller", async () => {
    prime([{ id: "p1", vehicleId: null, lat: 51.5, lng: 6.6, source: "manual" }], []);
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/parking/p1",
      payload: { note: "Level 3" },
    });
    expect(patch.statusCode).toBe(200);
    prime([{ id: "p1" }]);
    const remove = await app.inject({ method: "DELETE", url: "/api/parking/p1" });
    expect(remove.statusCode).toBe(200);
    for (const predicate of predicates.filter((p) => ["update", "delete"].includes(p.operation))) {
      expect(predicate.sql).toContain("user_id");
      expect(predicate.params).toEqual(["p1", "user-1"]);
    }
  });
});
