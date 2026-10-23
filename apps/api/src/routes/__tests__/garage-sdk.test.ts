import * as sdk from "@openmapx/core/garage-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../../../../packages/core/src/api/client";
import { uniformErrorHandler } from "../../server-wiring";
import { createDbMock } from "../../test/db";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { RateLimiter } from "../../utils/rate-limit";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

let database = createDbMock();
const session = vi.fn();
vi.mock("../../db/index", () => ({
  get db() {
    return database.db;
  },
}));
vi.mock("../../auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => session(...args) } },
}));
let app: FastifyInstance;
let limiter: RateLimiter;
const registered: { id: string | undefined; auth: unknown }[] = [];
const at = "2026-10-23T00:00:00.000Z";
const draft = {
  name: "Synthetic car",
  kind: "car" as const,
  powertrain: "petrol" as const,
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6,
};
const vehicle = { id: "vehicle", ...draft, createdAt: at, updatedAt: at };
const parked = {
  id: "parked",
  vehicleId: null,
  lat: 52,
  lng: 13,
  address: null,
  note: null,
  expiresAt: null,
  source: "manual" as const,
  accuracyMeters: null,
  savedAt: at,
  updatedAt: at,
};
const client = createApiClient({ baseUrl: "https://garage.example", credentials: "include" });

beforeEach(async () => {
  database = createDbMock();
  session.mockResolvedValue({ user: { id: "garage-user" } });
  registered.length = 0;
  app = Fastify();
  limiter = new RateLimiter({ max: 100, windowMs: 60_000 });
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRequest", limiter.preHandler());
  app.addHook("onRequest", makeCsrfGuardHook(["https://garage.example"]));
  app.addHook("onRoute", (route) => {
    if (route.method !== "HEAD")
      registered.push({
        id: route.schema?.operationId,
        auth: (route.config as { auth?: unknown })?.auth,
      });
  });
  const { garageRoute } = await import("../garage");
  await app.register(garageRoute, { prefix: "/api" });
  await app.ready();
  vi.stubGlobal("fetch", administrationSdkFetch(app));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  limiter.destroy();
  await app?.close();
});

it("registers exactly the complete eight-operation session family", () => {
  expect(registered.map((r) => r.id).sort()).toEqual(Object.keys(sdk.garageOperations).sort());
  expect(registered).toHaveLength(8);
  expect(registered.every((r) => r.auth === "session")).toBe(true);
});
it("round-trips all eight serialized producers through the generated SDK", async () => {
  database.queueSelect([{ ...vehicle, createdAt: new Date(at), updatedAt: new Date(at) }]);
  const listed = await sdk.listGarageVehicles({ client });
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(sdk.unwrapGarageResponse(listed)).toEqual({ vehicles: [vehicle] });

  database.queueSelect([{ id: "garage-user" }]);
  database.queueSelect([{ count: 0 }]);
  const created = sdk.unwrapGarageResponse(
    await sdk.createGarageVehicle({ ...draft, name: "  Synthetic car  " }, { client }),
  );
  expect(created).toEqual({ id: expect.any(String), ...draft });
  expect(created).not.toHaveProperty("createdAt");

  database.queueSelect([{ id: "garage-user" }]);
  database.queueSelect([vehicle]);
  expect(
    sdk.unwrapGarageResponse(
      await sdk.updateGarageVehicle("vehicle", { name: "Changed" }, { client }),
    ),
  ).toEqual({ ok: true });

  database.queueSelect([{ id: "garage-user" }]);
  database.queueSelect([{ id: "vehicle", isDefault: false }]);
  expect(sdk.unwrapGarageResponse(await sdk.deleteGarageVehicle("vehicle", { client }))).toEqual({
    ok: true,
  });

  database.queueSelect([{ ...parked, savedAt: new Date(at), updatedAt: new Date(at) }]);
  expect(sdk.unwrapGarageResponse(await sdk.listGarageParking({ client }))).toEqual({
    parked: [parked],
  });
  database.queueInsert([{ ...parked, savedAt: new Date(at), updatedAt: new Date(at) }]);
  const { id: _id, savedAt: _savedAt, updatedAt: _updatedAt, ...parkingDraft } = parked;
  expect(sdk.unwrapGarageResponse(await sdk.saveGarageParking(parkingDraft, { client }))).toEqual(
    parked,
  );
  database.queueSelect([parked]);
  expect(
    sdk.unwrapGarageResponse(
      await sdk.updateGarageParking("parked", { note: "Updated" }, { client }),
    ),
  ).toEqual({ ok: true });
  database.queueDelete([{ id: "parked" }]);
  expect(sdk.unwrapGarageResponse(await sdk.deleteGarageParking("parked", { client }))).toEqual({
    ok: true,
  });
});
it("authenticates before malformed body validation without any database work", async () => {
  session.mockResolvedValue(null);
  const response = await sdk.createGarageVehicle({} as never, { client });
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(database.db.select).not.toHaveBeenCalled();
  expect(database.db.insert).not.toHaveBeenCalled();
});
it("redacts malformed successful records and validates no-store on reads", async () => {
  database.queueSelect([{ ...vehicle, kind: "private malformed kind" }]);
  const response = await sdk.listGarageVehicles({ client });
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(response.data)).not.toContain("private malformed kind");
  expect(() => sdk.unwrapGarageResponse(response)).toThrow("status 500");
});
it("preserves cap conflict and refuses malformed or ownership-changing intent", async () => {
  database.queueSelect([{ id: "garage-user" }]);
  database.queueSelect([{ count: 12 }]);
  expect((await sdk.createGarageVehicle(draft, { client })).status).toBe(409);
  expect(
    (await sdk.createGarageVehicle({ ...draft, isDefault: "yes" } as never, { client })).status,
  ).toBe(400);
  expect(
    (await sdk.updateGarageParking("parked", { vehicleId: "foreign" } as never, { client })).status,
  ).toBe(400);
  expect(database.db.insert).not.toHaveBeenCalled();
  expect(database.db.update).not.toHaveBeenCalled();
});
it("keeps foreign vehicle and parking IDs absent without mutation", async () => {
  database.queueSelect([{ id: "garage-user" }]);
  database.queueSelect([]);
  expect((await sdk.updateGarageVehicle("foreign", { name: "Other" }, { client })).status).toBe(
    404,
  );
  expect((await sdk.updateGarageParking("foreign", { note: "Other" }, { client })).status).toBe(
    404,
  );
  expect(
    (
      await sdk.saveGarageParking(
        { vehicleId: "foreign", lat: 52, lng: 13, source: "manual" },
        { client },
      )
    ).status,
  ).toBe(404);
  expect(database.db.update).not.toHaveBeenCalled();
  expect(database.db.insert).not.toHaveBeenCalled();
});
it("retains cookie origin protection and real rate-limit metadata", async () => {
  const denied = await app.inject({
    method: "POST",
    url: "/api/vehicles",
    headers: { cookie: "session=synthetic", origin: "https://untrusted.example" },
    payload: draft,
  });
  expect(denied.statusCode).toBe(403);
  for (let index = 0; index < 99; index++)
    expect((await sdk.createGarageVehicle({} as never, { client })).status).toBe(400);
  const limited = await sdk.createGarageVehicle(draft, { client });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(database.db.insert).not.toHaveBeenCalled();
});
