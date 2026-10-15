import { eq } from "drizzle-orm";
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
  getUserId: () => "import-user",
}));

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "saved imports in PostgreSQL",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let app: FastifyInstance;
    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
      const { savedRoute } = await import("../saved");
      app = await buildTestApp(savedRoute, { prefix: "/api" });
      await fixture.db
        .insert(user)
        .values({ id: "import-user", name: "Importer", email: "import@example.test" });
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    });
    const fieldContributors = { lat: [{ sourceId: "geo", name: "Original geocoder" }], lng: [] };
    const point = { name: "Cafe", lat: 52, lng: 13, fieldContributors };
    const send = (target: unknown, places = [point]) =>
      app.inject({ method: "POST", url: "/api/saved/lists/import", payload: { target, places } });

    it("suffixes concurrent new-list imports and serializes duplicate membership", async () => {
      const responses = await Promise.all([send({ name: "Trip" }), send({ name: "Trip" })]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(responses.map((r) => r.json().name).sort()).toEqual(["Trip", "Trip (2)"]);
      const listId = responses[0].json().listId as string;
      const duplicate = await send({ listId }, [
        { ...point, lat: 52.000009 },
        { ...point, name: "Museum", lat: 53, lng: 14 },
        { ...point, name: "Museum", lat: 53, lng: 14 },
      ]);
      expect(duplicate.json()).toMatchObject({ imported: 1, skippedDuplicates: 2 });
      const more = await Promise.all([
        send({ listId }, [{ ...point, name: "Park", lat: 54, lng: 15 }]),
        send({ listId }, [{ ...point, name: "Park", lat: 54, lng: 15 }]),
      ]);
      expect(more.map((r) => r.json().imported).sort()).toEqual([0, 1]);
      const places = await fixture.db
        .select()
        .from(savedPlace)
        .where(eq(savedPlace.listId, listId))
        .orderBy(savedPlace.sortOrder);
      expect(places.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
      expect(places.every((p) => p.placeId === null)).toBe(true);
      expect(places.map((p) => p.fieldContributors)).toEqual([
        fieldContributors,
        fieldContributors,
        fieldContributors,
      ]);
    });
    it("rolls back a newly created list if any place cannot be inserted", async () => {
      await fixture.sql`CREATE FUNCTION import_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Reject' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`;
      await fixture.sql`CREATE TRIGGER import_test_reject BEFORE INSERT ON saved_place FOR EACH ROW EXECUTE FUNCTION import_test_reject()`;
      expect(
        (await send({ name: "Rollback" }, [point, { ...point, name: "Reject" }])).statusCode,
      ).toBe(500);
      expect(
        await fixture.db.select().from(savedList).where(eq(savedList.name, "Rollback")),
      ).toHaveLength(0);
      expect(
        await fixture.db.select().from(savedPlace).where(eq(savedPlace.name, "Reject")),
      ).toHaveLength(0);
    });
    it("does not import into another account's list", async () => {
      await fixture.db
        .insert(user)
        .values({ id: "other-import-user", name: "Other", email: "other-import@example.test" });
      await fixture.db
        .insert(savedList)
        .values({ id: "other-import-list", userId: "other-import-user", name: "Other" });
      expect((await send({ listId: "other-import-list" })).statusCode).toBe(404);
    });
  },
);
