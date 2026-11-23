import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../../../apps/api/src/test/postgres-fixture";

const state = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../../src/db/index", () => ({
  get db() {
    return state.db.db;
  },
  get sql() {
    return state.db.sql;
  },
}));

import { writeOvertureRelease } from "../../src/jobs/overture/release-state";
import {
  recordFetchOutcome,
  recordValidateOutcome,
  resetFeedStateCircuitForTests,
} from "../../src/jobs/transitous/feed-state-writer";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "data-manager source state on PostgreSQL",
  () => {
    beforeAll(async () => {
      state.db = await createMigratedPostgresFixture();
    }, 180_000);
    afterAll(async () => {
      await state.db?.stop();
    });
    beforeEach(async () => {
      resetFeedStateCircuitForTests();
      await state.db.sql`DELETE FROM data_manager.feed_state`;
      await state.db.sql`DELETE FROM data_manager.overture_release`;
    });

    it("counts a failure that waited on another writer's uncommitted first row of the feed", async () => {
      // Another writer inserted the feed's first row and has not committed.
      let commit = () => {};
      const committed = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let holding = () => {};
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const other = state.db.sql.begin(async (tx) => {
        await tx`INSERT INTO data_manager.feed_state (region, name, validation_status, status, consecutive_failures)
          VALUES ('de', 'race', 'error', 'failed', 1)
          ON CONFLICT (region, name) DO UPDATE SET consecutive_failures = feed_state.consecutive_failures + 1`;
        holding();
        await committed;
      });
      await held;
      const writer = recordValidateOutcome({
        region: "de",
        name: "race",
        ok: false,
        message: "bad",
      });
      // The writer blocks on the feed's key until the other one commits.
      let waiting = 0;
      for (let attempt = 0; attempt < 50 && waiting === 0; attempt++) {
        const [row] = await state.db.sql<{ n: number }[]>`SELECT count(*)::int AS n
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%data_manager%feed_state%'
            AND pid <> pg_backend_pid()`;
        waiting = row?.n ?? 0;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(1);
      commit();
      await other;
      await writer;
      expect(
        await state.db.sql`SELECT consecutive_failures FROM data_manager.feed_state
          WHERE region = 'de' AND name = 'race'`,
      ).toEqual([{ consecutive_failures: 2 }]);
    });

    it("keeps one row per feed and counts every validation failure", async () => {
      const failure = { region: "de", name: "demo", ok: false, message: "bad" };
      await Promise.all([recordValidateOutcome(failure), recordValidateOutcome(failure)]);
      await Promise.all([recordValidateOutcome(failure), recordFetchOutcome(failure)]);

      expect(
        await state.db.sql`SELECT region, name, status, validation_status, consecutive_failures
          FROM data_manager.feed_state`,
      ).toEqual([
        {
          region: "de",
          name: "demo",
          status: "failed",
          validation_status: "error",
          consecutive_failures: 3,
        },
      ]);

      await recordValidateOutcome({ region: "de", name: "demo", ok: true });
      expect(
        await state.db.sql`SELECT consecutive_failures, status FROM data_manager.feed_state`,
      ).toEqual([{ consecutive_failures: 0, status: "active" }]);
    });

    it("refuses a feed status outside the closed set", async () => {
      await expect(
        state.db
          .sql`INSERT INTO data_manager.feed_state (region, name, status) VALUES ('de', 'x', 'gone')`,
      ).rejects.toMatchObject({ constraint_name: "feed_state_status_check" });
      await expect(
        state.db
          .sql`INSERT INTO data_manager.feed_state (region, name, validation_status) VALUES ('de', 'x', 'maybe')`,
      ).rejects.toMatchObject({ constraint_name: "feed_state_validation_status_check" });
    });

    it("records the Overture release per region in its own table", async () => {
      const log = { warn: vi.fn() };
      await writeOvertureRelease(state.db.sql, "de", "2026-10-22.0", "waiting_for_osm", log);
      await writeOvertureRelease(state.db.sql, "de", "2026-11-19.0", "completed", log);
      await writeOvertureRelease(state.db.sql, "at", "2026-11-19.0", "failed", log);

      expect(log.warn).not.toHaveBeenCalled();
      expect(
        await state.db.sql`SELECT region, release, status,
            imported_at > now() - interval '1 minute' AS recent
          FROM data_manager.overture_release ORDER BY region`,
      ).toEqual([
        { region: "at", release: "2026-11-19.0", status: "links_pending", recent: true },
        { region: "de", release: "2026-11-19.0", status: "imported", recent: true },
      ]);
      expect(await state.db.sql`SELECT * FROM data_manager.feed_state`).toEqual([]);
    });
  },
);
