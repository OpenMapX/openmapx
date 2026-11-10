import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { savedList, savedPlace, user } from "../../db/schema";
import { buildTestApp } from "../../test/app";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const connection = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>["db"],
}));
vi.mock("../../db/index", () => ({
  get db() {
    return connection.db;
  },
}));
vi.mock("../../utils/require-auth", () => ({
  requireAuthHook: async () => {},
  getUserId: () => "order-user",
}));

const EARLIER = new Date("2026-10-01T10:00:00Z");
const LATER = new Date("2026-10-01T11:00:00Z");

// Equal positions only tie in a real table, and the row order a database returns
// for a tie is unspecified, so a mocked query cannot show that the order is fixed.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "saved list ordering in PostgreSQL",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let app: FastifyInstance;

    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
      const { sharesRoute, resetShareRateLimitsForTests } = await import("../shares");
      resetShareRateLimitsForTests();
      const { savedRoute } = await import("../saved");
      app = await buildTestApp(
        async (fastify: FastifyInstance) => {
          await fastify.register(sharesRoute);
          await fastify.register(savedRoute);
        },
        { prefix: "/api" },
      );
      await fixture.db
        .insert(user)
        .values({ id: "order-user", name: "Order", email: "order@example.test" });
    }, 120_000);

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    }, 60_000);

    const place = (id: string, sortOrder: number, createdAt: Date) => ({
      id,
      listId: "order-places",
      name: id,
      lat: 52,
      lng: 13,
      sortOrder,
      createdAt,
    });

    async function seedPlaces(): Promise<void> {
      await fixture.db
        .insert(savedList)
        .values({ id: "order-places", userId: "order-user", name: "Ties" });
      // Inserted in an order that matches none of the expected results.
      await fixture.db
        .insert(savedPlace)
        .values([
          place("x", 2, EARLIER),
          place("z", 0, LATER),
          place("b", 1, EARLIER),
          place("y", 0, EARLIER),
          place("a", 1, EARLIER),
        ]);
    }

    // Equal positions fall back to creation time, then id.
    const EXPECTED = ["y", "z", "a", "b", "x"];

    it("lists places with equal positions in creation then id order", async () => {
      await seedPlaces();
      const res = await app.inject({ method: "GET", url: "/api/saved/lists/order-places/places" });
      expect(res.statusCode).toBe(200);
      expect(res.json().places.map((p: { id: string }) => p.id)).toEqual(EXPECTED);
    });

    it("exports places with equal positions in the same order", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/saved/lists/order-places/export?format=geojson",
      });
      expect(res.statusCode).toBe(200);
      expect(
        res.json().features.map((f: { properties: { name: string } }) => f.properties.name),
      ).toEqual(EXPECTED);
    });

    it("shows a live share's places in the owner's order", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/shares",
        payload: { targetType: "list", targetId: "order-places", mode: "live" },
      });
      expect(created.statusCode).toBe(201);
      const shared = await app.inject({
        method: "GET",
        url: `/api/shares/${created.json().token}`,
      });
      expect(shared.statusCode).toBe(200);
      expect(shared.json().places.map((p: { name: string }) => p.name)).toEqual(EXPECTED);
    });

    it("lists lists with equal positions in creation then id order", async () => {
      await fixture.db.delete(savedList);
      const list = (id: string, createdAt: Date) => ({
        id,
        userId: "order-user",
        name: `List ${id}`,
        sortOrder: 5,
        createdAt,
      });
      await fixture.db
        .insert(savedList)
        .values([list("l-c", LATER), list("l-b", EARLIER), list("l-a", EARLIER)]);
      const res = await app.inject({ method: "GET", url: "/api/saved/lists" });
      expect(res.statusCode).toBe(200);
      expect(res.json().lists.map((l: { id: string }) => l.id)).toEqual(["l-a", "l-b", "l-c"]);
    });
  },
);
