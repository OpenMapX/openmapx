import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/garage-sdk";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { administrationSdkFetch } from "../../routes/__tests__/helpers/administration-sdk-fetch";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import { parkedLocation, personalVehicle, user } from "../schema";

const connection = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>["db"],
}));
// Only DB exports and authenticated identity are replaced; handlers and schema are real.
vi.mock("../index", () => ({
  get db() {
    return connection.db;
  },
}));
vi.mock("../../utils/require-auth", () => ({
  requireAuthHook: async () => {},
  getUserId: (req: FastifyRequest) => req.headers["x-test-user"],
}));

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "two-user garage isolation in migrated PostGIS",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let app: FastifyInstance;
    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
      const { garageRoute } = await import("../../routes/garage");
      app = Fastify();
      await app.register(garageRoute, { prefix: "/api" });
      await app.ready();
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    });
    beforeEach(async () => {
      await fixture.db.delete(user);
      await fixture.db
        .insert(user)
        .values(["a", "b"].map((id) => ({ id, name: id, email: `${id}@example.test` })));
      await fixture.db.insert(personalVehicle).values(
        ["a", "b"].map((id) => ({
          id: `v-${id}`,
          userId: id,
          name: `Car ${id}`,
          kind: "car" as const,
          powertrain: "petrol" as const,
          isDefault: true,
        })),
      );
      await fixture.db.insert(parkedLocation).values(
        ["a", "b"].map((id, i) => ({
          id: `p-${id}`,
          userId: id,
          vehicleId: `v-${id}`,
          lat: 50.123456 + i,
          lng: 6.654321 + i,
          note: `Private ${id}`,
          source: "manual" as const,
        })),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    const request = (
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url: string,
      payload?: object,
      caller = "a",
    ) => app.inject({ method, url: `/api${url}`, headers: { "x-test-user": caller }, payload });
    async function bState() {
      return {
        vehicles: await fixture.db
          .select()
          .from(personalVehicle)
          .where(eq(personalVehicle.userId, "b")),
        parking: await fixture.db
          .select()
          .from(parkedLocation)
          .where(eq(parkedLocation.userId, "b")),
      };
    }

    it("lists only each caller's vehicles and precise parking with no-store", async () => {
      for (const caller of ["a", "b"]) {
        const vehicles = await request("GET", "/vehicles", undefined, caller);
        expect(vehicles.statusCode).toBe(200);
        expect(vehicles.headers["cache-control"]).toBe("no-store");
        expect(vehicles.json().vehicles.map((v: { id: string }) => v.id)).toEqual([`v-${caller}`]);
        const parking = await request("GET", "/parking", undefined, caller);
        expect(parking.statusCode).toBe(200);
        expect(parking.headers["cache-control"]).toBe("no-store");
        expect(parking.json().parked.map((p: { id: string }) => p.id)).toEqual([`p-${caller}`]);
      }
    });

    it("denies foreign PATCH, DELETE and parking assignment without modifying B", async () => {
      const before = await bState();
      for (const [method, path, payload] of [
        ["PATCH", "/vehicles/v-b", { name: "Stolen", isDefault: true }],
        ["DELETE", "/vehicles/v-b", undefined],
        ["PATCH", "/parking/p-b", { note: "Stolen", lat: 1 }],
        ["DELETE", "/parking/p-b", undefined],
        ["PUT", "/parking", { vehicleId: "v-b", lat: 1, lng: 2, source: "manual" }],
      ] as const) {
        const response = await request(method, path, payload);
        expect(response.statusCode, `${method} ${path}`).toBe(404);
        expect(await bState()).toEqual(before);
      }
    });

    it("allows owned parking writes and deletion while preserving B's pin", async () => {
      const before = await bState();
      expect(
        (
          await request("PUT", "/parking", {
            vehicleId: "v-a",
            lat: 48.123456,
            lng: 11.654321,
            source: "manual" as const,
          })
        ).statusCode,
      ).toBe(200);
      expect((await request("PATCH", "/parking/p-a", { note: "Level 3" })).statusCode).toBe(200);
      const [own] = await fixture.db
        .select()
        .from(parkedLocation)
        .where(eq(parkedLocation.id, "p-a"));
      expect(own.lat).toBeCloseTo(48.123456, 6);
      expect(own.note).toBe("Level 3");
      expect((await request("DELETE", "/parking/p-a")).statusCode).toBe(200);
      expect(
        await fixture.db.select().from(parkedLocation).where(eq(parkedLocation.userId, "a")),
      ).toEqual([]);
      expect(await bState()).toEqual(before);
    });

    it("creates, changes and deletes A's default without changing B's default or pin", async () => {
      const before = await bState();
      const created = await request("POST", "/vehicles", {
        name: "New A",
        kind: "car" as const,
        powertrain: "petrol" as const,
        isDefault: true,
      });
      expect(created.statusCode).toBe(200);
      const id = created.json().id;
      const defaults = async () =>
        (await fixture.db.select().from(personalVehicle).where(eq(personalVehicle.userId, "a")))
          .filter((v) => v.isDefault)
          .map((v) => v.id);
      expect(await defaults()).toEqual([id]);
      expect(await bState()).toEqual(before);
      expect((await request("PATCH", "/vehicles/v-a", { isDefault: true })).statusCode).toBe(200);
      expect(await defaults()).toEqual(["v-a"]);
      expect(await bState()).toEqual(before);
      expect((await request("DELETE", "/vehicles/v-a")).statusCode).toBe(200);
      expect(await defaults()).toEqual([id]);
      expect(
        await fixture.db.select().from(parkedLocation).where(eq(parkedLocation.userId, "a")),
      ).toEqual([]);
      expect(await bState()).toEqual(before);
    });
    it("uses persisted serialized garage SDK records and receipts without owner metadata", async () => {
      vi.stubGlobal("fetch", administrationSdkFetch(app));
      const options = {
        client: createApiClient({ baseUrl: "http://garage.test", credentials: "include" }),
        headers: { "x-test-user": "a" },
      };
      const created = sdk.unwrapGarageResponse(
        await sdk.createGarageVehicle(
          { name: "SDK car", kind: "car", powertrain: "petrol" },
          options,
        ),
      );
      expect(created).not.toHaveProperty("userId");
      expect(created).not.toHaveProperty("createdAt");
      const read = await sdk.listGarageVehicles(options);
      expect(read.headers.get("cache-control")).toBe("no-store");
      const persisted = sdk
        .unwrapGarageResponse(read)
        .vehicles.find((row) => row.id === created.id);
      expect(persisted?.createdAt).toMatch(/^\d{4}-/);
      expect(persisted).not.toHaveProperty("userId");
      expect(
        sdk.unwrapGarageResponse(
          await sdk.updateGarageVehicle(created.id, { name: "Renamed" }, options),
        ),
      ).toEqual({ ok: true });
      const saved = sdk.unwrapGarageResponse(
        await sdk.saveGarageParking(
          {
            vehicleId: created.id,
            lat: 52,
            lng: 13,
            source: "manual",
            expiresAt: "2000-01-01T00:00:00Z",
          },
          options,
        ),
      );
      expect(saved.expiresAt).toBe("2000-01-01T00:00:00.000Z");
      expect(saved).not.toHaveProperty("userId");
      expect(
        sdk
          .unwrapGarageResponse(await sdk.listGarageParking(options))
          .parked.some((row) => row.id === saved.id),
      ).toBe(true);
      expect(
        sdk.unwrapGarageResponse(
          await sdk.updateGarageParking(saved.id, { note: "Level 2" }, options),
        ),
      ).toEqual({ ok: true });
      expect(sdk.unwrapGarageResponse(await sdk.deleteGarageParking(saved.id, options))).toEqual({
        ok: true,
      });
      expect(sdk.unwrapGarageResponse(await sdk.deleteGarageVehicle(created.id, options))).toEqual({
        ok: true,
      });
      expect((await bState()).vehicles).toHaveLength(1);
    });

    it("serializes concurrent creates at the last garage slot", async () => {
      await fixture.db.insert(personalVehicle).values(
        Array.from({ length: 10 }, (_, i) => ({
          id: `extra-${i}`,
          userId: "a",
          name: `Extra ${i}`,
          kind: "car" as const,
          powertrain: "petrol" as const,
          isDefault: false,
        })),
      );
      const replies = await Promise.all(
        ["One", "Two"].map((name) =>
          request("POST", "/vehicles", { name, kind: "car", powertrain: "petrol" }),
        ),
      );
      expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
      const rows = await fixture.db
        .select()
        .from(personalVehicle)
        .where(eq(personalVehicle.userId, "a"));
      expect(rows).toHaveLength(12);
      expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    });

    it("serializes concurrent first creates on an empty account", async () => {
      await fixture.db
        .insert(user)
        .values({ id: "empty", name: "Empty", email: "empty@example.test" });
      const replies = await Promise.all(
        ["One", "Two"].map((name) =>
          request("POST", "/vehicles", { name, kind: "car", powertrain: "petrol" }, "empty"),
        ),
      );
      expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
      const rows = await fixture.db
        .select()
        .from(personalVehicle)
        .where(eq(personalVehicle.userId, "empty"));
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    });
  },
);
