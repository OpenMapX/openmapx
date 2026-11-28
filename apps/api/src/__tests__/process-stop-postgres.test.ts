import type { DatabaseClient } from "@openmapx/integration-framework";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "a stop while extension database work runs, in migrated PostGIS",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let raw: Sql;
    let pools: typeof import("../db/index");
    let db: DatabaseClient;

    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      raw = fixture.sql;
      await raw`create schema ext_demo`;
      await raw`create table ext_demo.written (id int)`;
      vi.stubEnv("DATABASE_URL", fixture.connectionUri);
      pools = await import("../db/index");
      const { createIntegrationDb, integrationDbAccess } = await import("../integration-db");
      db = createIntegrationDb(
        { requests: pools.integrationSql, transactions: pools.extensionSql },
        integrationDbAccess({ id: "demo", database: { migrations: true } }),
      );
    }, 180_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await fixture?.stop();
    });

    it("exits within seconds and leaves the transaction uncommitted", async () => {
      const { createGracefulStopHandler } = await import("../process-lifecycle.js");
      const transaction = db.transaction(
        async (tx) => {
          await tx.execute("insert into written values ($1)", [1]);
          await tx.execute("select pg_sleep(15)");
        },
        { timeoutMs: 60_000 },
      );
      const outcome = transaction.then(
        () => "committed",
        () => "rolled back",
      );
      // The transaction is under way once its statement waits in the server.
      await vi.waitFor(
        async () => {
          const [row] = await raw<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where application_name = 'openmapx-api-extensions' and query like '%pg_sleep%'`;
          expect(row?.n).toBe(1);
        },
        { timeout: 10_000, interval: 100 },
      );

      const exit = vi.fn();
      const stop = createGracefulStopHandler({
        stop: async () => {},
        disconnect: async () => {},
        pools: [pools.sql, pools.integrationSql, pools.extensionSql],
        exit,
      });
      const startedAt = Date.now();
      const stopped = stop();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0), {
        timeout: 8_000,
        interval: 50,
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await stopped;

      expect(await outcome).toBe("rolled back");
      // The server notices the closed connection once the sleep ends and
      // rolls back instead of committing.
      await vi.waitFor(
        async () => {
          const [row] = await raw<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where application_name = 'openmapx-api-extensions' and state <> 'idle'`;
          expect(row?.n).toBe(0);
        },
        { timeout: 25_000, interval: 250 },
      );
      expect(await raw`select id from ext_demo.written`).toEqual([]);
    }, 60_000);
  },
);
