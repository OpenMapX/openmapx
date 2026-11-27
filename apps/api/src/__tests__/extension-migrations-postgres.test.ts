import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "@openmapx/integration-framework";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const INIT = "create table items (id int primary key, label text);";
const INDEX = "create index items_label_idx on items (label);";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "extension migrations in migrated PostGIS",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let raw: Sql;
    let pools: typeof import("../db/index");
    let migrations: typeof import("../extension-migrations");
    let integrationDb: typeof import("../integration-db");
    let root: string;

    /** An integration directory holding `files` under `migrations/`. */
    function shipping(files: Record<string, string>, integrationId = "demo") {
      const directory = mkdtempSync(join(root, `${integrationId}-`));
      mkdirSync(join(directory, "migrations"));
      for (const [name, text] of Object.entries(files))
        writeFileSync(join(directory, "migrations", name), text);
      return { integrationId, directory };
    }

    const args = () => shipping({ "0001_init.sql": INIT, "0002_index.sql": INDEX });

    function demoDb(integrationId = "demo"): DatabaseClient {
      return integrationDb.createIntegrationDb(
        { requests: pools.integrationSql, transactions: pools.extensionSql },
        {
          ...integrationDb.integrationDbAccess({
            id: integrationId,
            database: { migrations: true },
          }),
          integrationId,
        },
      );
    }

    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      raw = fixture.sql;
      root = mkdtempSync(join(tmpdir(), "omx-extension-migrations-pg-"));
      vi.stubEnv("DATABASE_URL", fixture.connectionUri);
      pools = await import("../db/index");
      migrations = await import("../extension-migrations");
      integrationDb = await import("../integration-db");
    }, 180_000);

    beforeEach(async () => {
      await raw.unsafe(
        "drop schema if exists ext_demo cascade; drop schema if exists ext_manual cascade",
      );
      await raw`delete from extension_migration`;
      await raw`drop table if exists public.items, public.late, public.stray`;
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
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

    it("creates the schema and applies pending files once", async () => {
      const demo = args();
      expect(await migrations.applyExtensionMigrations(demo)).toEqual({
        applied: ["0001_init.sql", "0002_index.sql"],
        schemaAhead: false,
      });
      expect((await migrations.applyExtensionMigrations(demo)).applied).toEqual([]);
      expect(
        await raw`select name, sha256 ~ '^[a-f0-9]{64}$' as hex from extension_migration where integration_id = 'demo' order by name`,
      ).toEqual([
        { name: "0001_init.sql", hex: true },
        { name: "0002_index.sql", hex: true },
      ]);
      expect(
        await raw`select to_regclass('ext_demo.items') is not null as created,
          to_regclass('public.items') is null as not_public`,
      ).toEqual([{ created: true, not_public: true }]);
    });

    it("refuses an existing schema the API role does not own", async () => {
      await raw.unsafe(
        "do $$ begin if not exists (select from pg_roles where rolname = 'someone_else') then create role someone_else; end if; end $$",
      );
      await raw`create schema ext_demo authorization someone_else`;

      await expect(migrations.applyExtensionMigrations(args())).rejects.toThrow(
        "Schema ext_demo of demo is not owned by the API role",
      );
      expect(
        await raw`select count(*)::int as n from extension_migration where integration_id = 'demo'`,
      ).toEqual([{ n: 0 }]);
    });

    it("applies nothing when one file fails", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": INIT, "0002_index.sql": "create index on;" }),
        ),
      ).rejects.toThrow();
      expect(
        await raw`select count(*)::int as n from extension_migration where integration_id = 'demo'`,
      ).toEqual([{ n: 0 }]);
      expect(await raw`select to_regclass('ext_demo.items') is null as gone`).toEqual([
        { gone: true },
      ]);
    });

    it("refuses a file that ends the migration transaction", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": `${INIT} commit; create table later (id int);` }),
        ),
      ).rejects.toThrow("Migration 0001_init.sql of demo ended the migration transaction");
    });

    it("refuses an applied migration whose bytes changed", async () => {
      await migrations.applyExtensionMigrations(args());
      const changed = shipping({
        "0001_init.sql": `${INIT} -- changed`,
        "0002_index.sql": INDEX,
      });

      await expect(migrations.applyExtensionMigrations(changed)).rejects.toThrow(
        "Migration 0001_init.sql of demo changed after it was applied",
      );
    });

    it("lets the previous version load after a newer one migrated", async () => {
      const withThreeFiles = shipping({
        "0001_init.sql": INIT,
        "0002_index.sql": INDEX,
        "0003_more.sql": "alter table items add column extra text;",
      });
      const withTwoFiles = args();

      await migrations.applyExtensionMigrations(withThreeFiles);
      expect(await migrations.applyExtensionMigrations(withTwoFiles)).toEqual({
        applied: [],
        schemaAhead: true,
      });
    });

    it("refuses a file older than an applied migration", async () => {
      await migrations.applyExtensionMigrations(
        shipping({ "0001_init.sql": INIT, "0003_more.sql": "alter table items add column x int;" }),
      );

      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": INIT, "0002_index.sql": INDEX }),
        ),
      ).rejects.toThrow(
        "Migration 0002_index.sql of demo is older than a migration that was already applied",
      );
      expect(await raw`select to_regclass('ext_demo.items_label_idx') is null as not_run`).toEqual([
        { not_run: true },
      ]);
    });

    it("runs a migration longer than the request timeout", async () => {
      expect(
        await migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": `${INIT} select pg_sleep(6);` }),
        ),
      ).toEqual({ applied: ["0001_init.sql"], schemaAhead: false });
    }, 30_000);

    it("gives up waiting for a lock after the lock timeout and leaves nothing applied", async () => {
      const holder = postgres(fixture.connectionUri, { max: 1 });
      try {
        await holder`select pg_advisory_lock(hashtextextended('openmapx-ext-migrations:demo', 0))`;
        const started = Date.now();
        await expect(
          migrations.applyExtensionMigrations({ ...args(), limits: { lockTimeoutMs: 2_000 } }),
        ).rejects.toThrow("Migrations of demo waited longer than 2 seconds for a database lock");
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        await holder.end({ timeout: 5 });
      }
      expect(
        await raw`select count(*)::int as n from extension_migration where integration_id = 'demo'`,
      ).toEqual([{ n: 0 }]);
    }, 30_000);

    it("ends migrations that outlive the overall limit and rolls them back", async () => {
      const started = Date.now();
      await expect(
        migrations.applyExtensionMigrations({
          ...shipping({ "0001_init.sql": `${INIT} select pg_sleep(60);` }),
          limits: { deadlineMs: 2_000 },
        }),
      ).rejects.toThrow("Migrations of demo did not finish within 2 seconds");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await raw`select to_regclass('ext_demo.items') is null as gone`).toEqual([
        { gone: true },
      ]);
      expect(
        await raw`select count(*)::int as n from pg_stat_activity
          where application_name = 'openmapx-api-migrations' and state = 'active'
            and query like '%pg_sleep(60)%'`,
      ).toEqual([{ n: 0 }]);
    }, 30_000);

    it("lets a user table cascade from the platform user", async () => {
      await migrations.applyExtensionMigrations(
        shipping({
          "0001_init.sql":
            'create table notes (user_id text not null references public."user"(id) on delete cascade, body text);',
        }),
      );
      await raw`insert into "user" (id, name, email, role, created_at, updated_at)
        values ('note-owner', 'Owner', 'owner@example.test', 'user', now(), now())`;
      await raw`insert into ext_demo.notes (user_id, body) values ('note-owner', 'hello')`;

      await raw`delete from "user" where id = 'note-owner'`;

      expect(await raw`select count(*)::int as n from ext_demo.notes`).toEqual([{ n: 0 }]);
    });

    it("removes an integration's schema and bookkeeping, and a reinstall starts from 0001", async () => {
      await migrations.applyExtensionMigrations(args());
      await raw`insert into integration_task_run (integration_id, task_name, status, finished_at)
        values ('demo', 'sync', 'succeeded', now()), ('other', 'sync', 'succeeded', now())`;
      await raw`insert into subject_erasure_pending (integration_id, subject_user_id) values ('demo', 'u1')`;
      await raw`insert into integration_subject_handler (integration_id) values ('demo')`;

      expect(await raw.begin((tx) => migrations.removeIntegrationData(tx, "demo"))).toEqual({
        schema: "ext_demo",
      });

      expect(await raw`select to_regnamespace('ext_demo') is null as gone`).toEqual([
        { gone: true },
      ]);
      expect(
        await raw`select
          (select count(*)::int from extension_migration where integration_id = 'demo') as migrations,
          (select count(*)::int from integration_task_run where integration_id = 'demo') as runs,
          (select count(*)::int from integration_task_run where integration_id = 'other') as other_runs,
          (select count(*)::int from subject_erasure_pending where integration_id = 'demo') as pending,
          (select count(*)::int from integration_subject_handler where integration_id = 'demo') as handlers`,
      ).toEqual([{ migrations: 0, runs: 0, other_runs: 1, pending: 0, handlers: 0 }]);
      expect((await migrations.applyExtensionMigrations(args())).applied).toEqual([
        "0001_init.sql",
        "0002_index.sql",
      ]);
      await raw`delete from integration_task_run`;
    });

    it("refuses the database calls of a removed integration and touches nothing in public", async () => {
      await migrations.applyExtensionMigrations(args());
      const loaded = demoDb();
      expect(await loaded.execute("select count(*)::int as n from items")).toEqual([{ n: 0 }]);

      await raw.begin((tx) => migrations.removeIntegrationData(tx, "demo"));

      await expect(loaded.execute("create table late (id int)")).rejects.toThrow(
        "The data of integration demo was removed",
      );
      await expect(
        loaded.transaction((tx) => tx.execute("create table late (id int)")),
      ).rejects.toThrow("The data of integration demo was removed");
      expect(await raw`select to_regclass('public.late') is null as untouched`).toEqual([
        { untouched: true },
      ]);

      // A new installation loads with a new client, which works again.
      await migrations.applyExtensionMigrations(args());
      expect(await demoDb().execute("select count(*)::int as n from items")).toEqual([{ n: 0 }]);
      await expect(loaded.execute("select 1")).rejects.toThrow(
        "The data of integration demo was removed",
      );
    });

    it("never falls back to public when the integration's schema is missing", async () => {
      const manual = demoDb("manual");

      await expect(manual.execute("create table stray (id int)")).rejects.toThrow(
        "Schema ext_manual does not exist",
      );
      await expect(
        manual.transaction((tx) => tx.execute("create table stray (id int)")),
      ).rejects.toThrow("Schema ext_manual does not exist");
      expect(await raw`select to_regclass('public.stray') is null as untouched`).toEqual([
        { untouched: true },
      ]);
    });
  },
);
