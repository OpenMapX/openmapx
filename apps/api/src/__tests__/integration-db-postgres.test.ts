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
    /** A second integration sharing the pools. */
    let other: DatabaseClient;

    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      raw = fixture.sql;
      await raw`create schema ext_demo`;
      vi.stubEnv("DATABASE_URL", fixture.connectionUri);
      pools = await import("../db/index");
      const { createIntegrationDb, integrationDbAccess } = await import("../integration-db");
      const shared = { requests: pools.integrationSql, transactions: pools.extensionSql };
      db = createIntegrationDb(
        shared,
        integrationDbAccess({ id: "demo", database: { migrations: true } }),
      );
      other = createIntegrationDb(
        shared,
        integrationDbAccess({ id: "other", requires: [{ service: "postgis" }] }),
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
        { statement: "2s", idle: "2s", path: '"ext_demo", extensions' },
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

    it("commits nothing of a callback that goes on issuing statements past its deadline", async () => {
      await db.transaction((tx) => tx.execute("create table busy (id int)"));
      let callbackDone!: () => void;
      const callbackSettled = new Promise<void>((resolve) => {
        callbackDone = resolve;
      });

      await expect(
        db.transaction(
          async (tx) => {
            try {
              for (let id = 0; id < 25; id += 1) {
                await tx.execute("insert into busy values ($1)", [id]);
                await sleep(100);
              }
            } finally {
              callbackDone();
            }
          },
          { timeoutMs: 1_000 },
        ),
      ).rejects.toBeInstanceOf(ProviderTimeoutError);
      await callbackSettled;
      // Queued behind the transaction above, so it starts once that one has
      // committed or rolled back.
      await db.transaction(noop);

      expect(await raw`select count(*)::int as n from ext_demo.busy`).toEqual([{ n: 0 }]);
      await Promise.all([
        db.transaction(noop, { timeoutMs: 1_000 }),
        other.transaction(noop, { timeoutMs: 1_000 }),
      ]);
    }, 15_000);

    it("reports the outcome of a COMMIT that outlasts the deadline", async () => {
      // A deferred constraint trigger runs inside the COMMIT, which then lasts
      // past the client-side deadline but within the statement timeout.
      await raw.unsafe(`
        create table ext_demo.slow_commit (id int);
        create function ext_demo.slow_commit_check() returns trigger language plpgsql as
          $$ begin perform pg_sleep(1.2); return null; end $$;
        create constraint trigger slow_commit_check after insert on ext_demo.slow_commit
          deferrable initially deferred for each row execute function ext_demo.slow_commit_check();
      `);
      const started = Date.now();

      await expect(
        db.transaction(
          async (tx) => {
            await tx.execute("insert into slow_commit values (1)");
            await sleep(1_200);
            return "committed";
          },
          { timeoutMs: 2_000 },
        ),
      ).resolves.toBe("committed");

      expect(Date.now() - started).toBeGreaterThan(2_000);
      expect(await raw`select count(*)::int as n from ext_demo.slow_commit`).toEqual([{ n: 1 }]);
    }, 15_000);

    it("keeps a connection free for other integrations while one holds a long transaction", async () => {
      const entered: string[] = [];
      const holding = db.transaction(
        async (tx) => {
          entered.push("first");
          await tx.execute("select pg_sleep(3)");
        },
        { timeoutMs: 10_000 },
      );
      const queued = db.transaction(
        async (tx) => {
          entered.push("second");
          await tx.execute("select pg_sleep(1)");
        },
        { timeoutMs: 10_000 },
      );
      await vi.waitFor(() => expect(entered).toEqual(["first"]));

      const started = Date.now();
      await expect(
        other.transaction((tx) => tx.execute("select 1 as ok"), { timeoutMs: 2_000 }),
      ).resolves.toEqual([{ ok: 1 }]);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(entered).toEqual(["first"]);

      await Promise.all([holding, queued]);
      expect(entered).toEqual(["first", "second"]);
    }, 20_000);
  },
);
