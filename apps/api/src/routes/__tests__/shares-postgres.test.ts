import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { shareLink, user } from "../../db/schema";
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
  getUserId: () => "share-cap-user",
}));

// A real database is needed: a mocked transaction cannot verify row-lock isolation.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "share creation concurrency in PostgreSQL",
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
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    }, 60_000);

    it("admits only one simultaneous creation into the last share slot", async () => {
      await fixture.db
        .insert(user)
        .values({ id: "share-cap-user", name: "Share", email: "share@example.test" });
      await fixture.db.insert(shareLink).values(
        Array.from({ length: 99 }, (_, i) => ({
          id: `existing-${i}`,
          userId: "share-cap-user",
          tokenHash: `hash-${i}`,
          targetType: "route",
          mode: "snapshot",
          label: "Existing",
        })),
      );
      // Hold both unprotected inserts long enough for both handlers to count 99.
      await fixture.sql`CREATE FUNCTION share_test_insert_delay() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`;
      await fixture.sql`CREATE TRIGGER share_test_insert_delay BEFORE INSERT ON share_link
      FOR EACH ROW EXECUTE FUNCTION share_test_insert_delay()`;
      const payload = {
        targetType: "route",
        route: {
          mode: "driving",
          waypoints: [
            { lat: 52.52, lng: 13.405, label: "Berlin" },
            { lat: 53.55, lng: 9.99, label: "Hamburg" },
          ],
        },
      };
      const responses = await Promise.all(
        [1, 2].map(() => app.inject({ method: "POST", url: "/api/shares", payload })),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      expect(
        await fixture.db.select().from(shareLink).where(eq(shareLink.userId, "share-cap-user")),
      ).toHaveLength(100);
    });

    it("persists acquired fields, isolates edits, and exposes frozen/public/export receipts after generated migrations", async () => {
      await fixture.db.delete(shareLink).where(eq(shareLink.userId, "share-cap-user"));
      const source = {
        sourceId: "provider",
        name: "Original publisher",
        attributionText: "Original required notice",
      };
      const geometry = { ...source, attributionText: "Distinct coordinate terms" };
      const fieldContributors = { name: [source], address: [], lat: [geometry], lng: [geometry] };
      const listResponse = await app.inject({
        method: "POST",
        url: "/api/saved/lists",
        payload: { name: "Captured list" },
      });
      const listId = listResponse.json().id;
      const created = await app.inject({
        method: "POST",
        url: `/api/saved/lists/${listId}/places`,
        payload: { name: "Acquired name", address: null, lat: 50, lng: 8, fieldContributors },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().fieldContributors).toEqual(fieldContributors);
      expect(created.json().address).toBeNull();
      const id = created.json().id;
      const read = async () =>
        (await app.inject({ method: "GET", url: `/api/saved/lists/${listId}/places` })).json()
          .places[0];
      expect((await read()).fieldContributors).toEqual(fieldContributors);
      // An unchanged sourced name and a note edit keep acquisition ownership.
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/saved/places/${id}`,
            payload: { note: "My note", name: "Acquired name" },
          })
        ).statusCode,
      ).toBe(200);
      expect((await read()).fieldContributors).toEqual(fieldContributors);
      // Independent simultaneous edits must not resurrect either field's old receipt.
      const edits = await Promise.all([
        app.inject({
          method: "PATCH",
          url: `/api/saved/places/${id}`,
          payload: { name: "My name" },
        }),
        app.inject({ method: "PATCH", url: `/api/saved/places/${id}`, payload: { lat: 51 } }),
      ]);
      expect(edits.map((response) => response.statusCode)).toEqual([200, 200]);
      const edited = { ...fieldContributors, name: [], lat: [] };
      expect((await read()).fieldContributors).toEqual(edited);
      for (const mode of ["snapshot", "live"]) {
        const shared = await app.inject({
          method: "POST",
          url: "/api/shares",
          payload: { targetType: "list", targetId: listId, mode },
        });
        expect(shared.statusCode).toBe(201);
        const publicView = await app.inject({
          method: "GET",
          url: `/api/shares/${shared.json().token}`,
        });
        expect(publicView.statusCode).toBe(200);
        expect(publicView.json().places[0].fieldContributors).toEqual(edited);
      }
      const exported = await app.inject({
        method: "GET",
        url: `/api/saved/lists/${listId}/export?format=geojson`,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().features[0].properties.fieldContributors).toEqual(edited);
      expect(JSON.stringify(exported.json().features[0].properties.attribution)).toContain(
        "Distinct coordinate terms",
      );
      const labeled = await app.inject({
        method: "PUT",
        url: "/api/saved/labels/home",
        payload: { name: "Acquired label", lat: 50, lng: 8, fieldContributors },
      });
      expect(labeled.statusCode).toBe(200);
      const labels = await app.inject({ method: "GET", url: "/api/saved/labels" });
      expect(labels.json().labels[0].fieldContributors).toEqual(fieldContributors);
    });
  },
);
