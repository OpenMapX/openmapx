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
      app = await buildTestApp(sharesRoute, { prefix: "/api" });
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    });

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
  },
);
