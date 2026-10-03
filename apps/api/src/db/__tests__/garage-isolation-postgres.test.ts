import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  },
);
