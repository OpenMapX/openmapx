import { setTimeout as sleep } from "node:timers/promises";
import { type DatabaseClient, ProviderTimeoutError } from "@openmapx/integration-framework";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const noop = async () => {};

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "integration ctx.db in migrated PostGIS",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let raw: Sql;
    let pools: typeof import("../db/index");
    let db: DatabaseClient;

    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      raw = fixture.sql;
      await raw`create schema ext_demo`;
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
      try {
        await Promise.all([
          pools?.sql.end({ timeout: 5 }),
          pools?.integrationSql.end({ timeout: 5 }),
          pools?.extensionSql.end({ timeout: 5 }),
        ]);
      } finally {
        await fixture?.stop();
      }
    });

    it("commits what the callback wrote and rolls back when it throws", async () => {
      await db.transaction((tx) => tx.execute("create table kept (id int)"));
      await db.transaction((tx) => tx.execute("insert into kept values ($1)", [1]));
      await expect(
        db.transaction(async (tx) => {
          await tx.execute("insert into kept values ($1)", [2]);
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");

      expect(await raw`select id from ext_demo.kept`).toEqual([{ id: 1 }]);
    });

    it("resolves unqualified names in the integration's own schema", async () => {
      await db.transaction((tx) => tx.execute("create table t (id int)"));
      expect(await raw`select to_regclass('ext_demo.t') is not null as ok`).toEqual([{ ok: true }]);
    });

    it("lets execute read a table of its schema without a prefix", async () => {
      expect(await db.execute("select count(*)::int as n from t")).toEqual([{ n: 0 }]);
    });

    it("sets its timeouts and search path for the transaction only", async () => {
      const settings = `select current_setting('statement_timeout') as statement,
        current_setting('idle_in_transaction_session_timeout') as idle,
        current_setting('search_path') as path`;
      expect(await db.transaction((tx) => tx.execute(settings), { timeoutMs: 2_000 })).toEqual([
        { statement: "2s", idle: "2s", path: '"ext_demo", public' },
      ]);
      const pooled = await Promise.all([
        pools.extensionSql.unsafe(settings),
        pools.extensionSql.unsafe(settings),
      ]);
      expect(pooled.flat().map(({ statement, idle }) => ({ statement, idle }))).toEqual([
        { statement: "30s", idle: "0" },
        { statement: "30s", idle: "0" },
      ]);
    });

    it("ends a statement at the declared timeout with the host's timeout error", async () => {
      const started = Date.now();
      await expect(
        db.transaction((tx) => tx.execute("select pg_sleep(3)"), { timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(Date.now() - started).toBeLessThan(2_500);
    }, 10_000);

    it("rolls back a transaction that idles past its timeout and frees its connection", async () => {
      await expect(
        db.transaction(
          async (tx) => {
            await tx.execute("insert into t values (1)");
            await sleep(3_000);
          },
          { timeoutMs: 1_000 },
        ),
      ).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(await db.execute("select count(*)::int as n from t")).toEqual([{ n: 0 }]);
      await Promise.all([db.transaction(noop), db.transaction(noop)]);
    }, 10_000);

    it("does not take request-pool connections for a long transaction", async () => {
      let transactionDone = false;
      const transaction = db
        .transaction(async (tx) => {
          const [row] = await tx.execute<Array<{ name: string }>>(
            "select current_setting('application_name') as name",
          );
          await tx.execute("select pg_sleep(2)");
          return row?.name;
        })
        .finally(() => {
          transactionDone = true;
        });

      const requests = await Promise.all(
        Array.from({ length: 4 }, () =>
          db.execute<Array<{ name: string }>>("select current_setting('application_name') as name"),
        ),
      );

      expect(transactionDone).toBe(false);
      expect(requests.flat()).toEqual(
        Array.from({ length: 4 }, () => ({ name: "openmapx-api-integrations" })),
      );
      expect(await transaction).toBe("openmapx-api-extensions");
    }, 10_000);
  },
);
