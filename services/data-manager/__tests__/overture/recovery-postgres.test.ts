/** Real authenticated read-only recovery inspection, owned PostgreSQL and lock. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../../../apps/api/src/test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as Awaited<ReturnType<typeof createMigratedPostgresFixture>> | null,
}));
vi.mock("../../src/db/index", () => ({
  get db() {
    return state.fixture?.db;
  },
  get sql() {
    return state.fixture?.sql;
  },
  get rawSql() {
    return state.fixture?.sql;
  },
}));
it.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "reports missing inputs and the actual Overture lease without creating files",
  async () => {
    const fixture = await createMigratedPostgresFixture();
    state.fixture = fixture;
    const root = mkdtempSync(join(tmpdir(), "omx-overture-recovery-")),
      app = Fastify();
    try {
      const { registerApi } = await import("../../src/api"),
        { registerAuth } = await import("../../src/auth");
      const { OVERTURE_LOCK_NAMESPACE, OVERTURE_LOCK_KEY } = await import(
        "../../src/jobs/overture/operation-lock"
      );
      registerAuth(app, "synthetic-recovery-token");
      registerApi(app, { dataDir: root });
      const request = () =>
        app.inject({
          method: "GET",
          url: "/overture/recovery?region=europe/germany",
          headers: { authorization: "Bearer synthetic-recovery-token" },
        });
      const response = await request();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        region: "europe/germany",
        busy: false,
        downloadedRelease: null,
        osmAvailable: false,
        actions: {
          "overture-pull": { allowed: true },
          "overture-ingest": { allowed: false },
          "overture-extract": { allowed: false },
          "overture-restart": { allowed: false },
        },
      });
      const held = await fixture.sql.reserve();
      try {
        await held`SELECT pg_advisory_lock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`;
        const busy = await request();
        expect(busy.statusCode).toBe(200);
        expect(busy.json()).toMatchObject({
          busy: true,
          actions: {
            "overture-pull": { allowed: false },
            "overture-ingest": { allowed: false },
            "overture-extract": { allowed: false },
            "overture-conflate": { allowed: false },
          },
        });
      } finally {
        await held`SELECT pg_advisory_unlock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`;
        held.release();
      }
      const { assertOvertureRecoveryInputs } = await import("../../src/jobs/overture/recovery");
      const { withOvertureOperationLock } = await import("../../src/jobs/overture/operation-lock");
      const { buildSchemaDDL } = await import("../../src/jobs/overture/schema");
      await fixture.sql.unsafe(buildSchemaDDL("overture_places"));
      await fixture.sql.unsafe(
        `INSERT INTO overture_places.places (gers_id, geom, release) VALUES ('published-place', ST_SetSRID(ST_MakePoint(13,52),4326), '2026-10-21.0')`,
      );
      await fixture.sql.unsafe(
        `INSERT INTO overture_places.conflation_state (release,region,place_count,status) VALUES ('2026-10-21.0','europe/germany',1,'pending')`,
      );
      for (const kind of ["overture-ingest", "overture-extract", "overture-conflate"] as const) {
        await expect(
          withOvertureOperationLock(() =>
            assertOvertureRecoveryInputs(root, "europe/germany", kind, true),
          ),
        ).rejects.toThrow(/Download/);
      }
      await expect(
        withOvertureOperationLock(() =>
          assertOvertureRecoveryInputs(root, "europe/france", "overture-extract"),
        ),
      ).rejects.toThrow(/Ingest this region/);
      expect(
        await fixture.sql.unsafe("SELECT gers_id, release FROM overture_places.places"),
      ).toEqual([expect.objectContaining({ gers_id: "published-place", release: "2026-10-21.0" })]);
      expect(
        (
          await fixture.sql.unsafe(
            "SELECT status, attempt_count FROM overture_places.conflation_state",
          )
        )[0],
      ).toMatchObject({ status: "pending", attempt_count: 0 });
      await fixture.sql.unsafe("UPDATE overture_places.conflation_state SET status='completed'");
      await expect(
        withOvertureOperationLock(() =>
          assertOvertureRecoveryInputs(root, "europe/germany", "overture-conflate", false),
        ),
      ).resolves.toBeNull();
      await expect(
        withOvertureOperationLock(() =>
          assertOvertureRecoveryInputs(root, "europe/germany", "overture-conflate", true),
        ),
      ).rejects.toThrow(/OSM PBF/);
      const failedRead = vi
        .spyOn(fixture.sql, "unsafe")
        .mockRejectedValueOnce(Error("Synthetic lock-read outage"));
      try {
        const unavailable = await request();
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({
          ok: false,
          error: "Overture prerequisite inspection is unavailable",
        });
      } finally {
        failedRead.mockRestore();
      }
      expect(readdirSync(root)).toEqual([]);
      expect(
        (await app.inject({ method: "GET", url: "/overture/recovery?region=europe/germany" }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
      state.fixture = null;
      await fixture.stop();
    }
  },
  60000,
);
