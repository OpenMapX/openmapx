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
    "onConflictDoUpdate",
    "returning",
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

const fakeDb = {
  select: () => makeChain(),
  insert: () => makeChain(),
  update: () => makeChain(),
  delete: () => makeChain(),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

vi.mock("../../db/index.js", () => ({ db: fakeDb }));

vi.mock("../../db/schema.js", () => ({
  personalVehicle: {
    id: "id",
    userId: "userId",
    name: "name",
    kind: "kind",
    powertrain: "powertrain",
    isDefault: "isDefault",
    presetId: "presetId",
    ev: "ev",
    fuelConsumptionLPer100Km: "fuelConsumptionLPer100Km",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  parkedLocation: {
    id: "id",
    userId: "userId",
    vehicleId: "vehicleId",
    lat: "lat",
    lng: "lng",
    address: "address",
    note: "note",
    expiresAt: "expiresAt",
    source: "source",
    accuracyMeters: "accuracyMeters",
    savedAt: "savedAt",
    updatedAt: "updatedAt",
  },
}));

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
  });

  it("404s DELETE on a vehicle the caller does not own", async () => {
    prime([]);
    const res = await app.inject({ method: "DELETE", url: "/api/vehicles/other" });
    expect(res.statusCode).toBe(404);
  });
});

describe("parking", () => {
  it("lists parked records without caching them", async () => {
    prime([{ id: "p1", vehicleId: null, lat: 51.5, lng: 6.6 }]);
    const res = await app.inject({ method: "GET", url: "/api/parking" });
    expect(res.statusCode).toBe(200);
    expect(res.json().parked).toHaveLength(1);
    expect(res.headers["cache-control"]).toBe("no-store");
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
  });

  it("404s DELETE on a record the caller does not own", async () => {
    prime([]);
    const res = await app.inject({ method: "DELETE", url: "/api/parking/other" });
    expect(res.statusCode).toBe(404);
  });
});
