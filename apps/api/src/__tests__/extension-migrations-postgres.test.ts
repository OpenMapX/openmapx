import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "@openmapx/integration-framework";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_MIGRATIONS,
  connectProductionPostgis,
  productionPostgisPasswords,
  startProductionPostgis,
} from "../test/production-postgis";

const INIT = "create table items (id int primary key, label text);";
const INDEX = "create index items_label_idx on items (label);";

/** Tables the tests may leave in `public` when a migration escapes its schema. */
const STRAY_PUBLIC_TABLES = ["items", "late", "later", "stray", "a", "b", "y", "shadowed"];

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "extension migrations in the production PostGIS layout",
  () => {
    const passwords = productionPostgisPasswords();
    let container: StartedPostgreSqlContainer;
    /** The superuser, for setup and for looking at what a migration left behind. */
    let raw: Sql;
    /** The API role, which owns the platform tables and runs the migrations. */
    let api: Sql;
    let apiUrl: string;
    let pools: typeof import("../db/index");
    let migrations: typeof import("../extension-migrations");
    let integrationDb: typeof import("../integration-db");
    let processLogger: typeof import("../process-logger")["processLogger"];
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

    /**
     * Deletes the account as a self-service deletion does: in an account
     * mutation, with the production erasure hooks, journal and key files.
     */
    async function deleteAccount(userId: string) {
      const { initializeErasureJournal } = await import("@openmapx/core/erasure-journal");
      const { eq } = await import("drizzle-orm");
      const { withAccountMutation } = await import("../account/account-mutations");
      const { userErasureHooks } = await import("../services/user-erasure");
      const { user } = await import("../db/schema");
      const files = mkdtempSync(join(root, "erasure-"));
      const journalKey = randomBytes(32);
      const journalPath = join(files, "journal.jsonl");
      initializeErasureJournal(journalPath, journalKey, new Date());
      writeFileSync(join(files, "journal-key"), journalKey.toString("base64url"), { mode: 0o444 });
      writeFileSync(join(files, "offline-key"), randomBytes(32).toString("base64url"), {
        mode: 0o444,
      });
      vi.stubEnv("ERASURE_JOURNAL_PATH", journalPath);
      vi.stubEnv("ERASURE_JOURNAL_KEY_FILE", join(files, "journal-key"));
      vi.stubEnv("ERASURE_JOURNAL_KEY_UID", String(process.getuid?.() ?? 0));
      vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", join(files, "offline-key"));
      vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_UID", undefined);
      const subject = { id: userId, email: `${userId}@example.test` };
      await withAccountMutation(
        {
          actorId: userId,
          targetId: userId,
          action: "delete",
          mutationKey: `erasure-${userId}`,
          selfServiceDelete: true,
        },
        async (tx) => {
          await userErasureHooks.before(subject);
          await tx.delete(user).where(eq(user.id, userId));
          await userErasureHooks.after(subject);
        },
        pools.db,
      );
    }

    /** What the run left behind: the demo schema, its rows, and stray tables in `public`. */
    async function leftBehind() {
      const [state] = await raw<
        Array<{ schema: boolean; rows: number; stray: string[] | null }>
      >`select to_regnamespace('ext_demo') is not null as schema,
          (select count(*)::int from extension_migration where integration_id = 'demo') as rows,
          (select array_agg(relname::text order by relname) from pg_class
            where relnamespace = 'public'::regnamespace and relname = any(${STRAY_PUBLIC_TABLES})) as stray`;
      return state;
    }

    beforeAll(async () => {
      container = await startProductionPostgis(passwords);
      raw = connectProductionPostgis(container, "postgres", passwords.superuser);
      api = connectProductionPostgis(container, "openmapx_api", passwords.api);
      await migrate(drizzle(api), { migrationsFolder: API_MIGRATIONS });
      const url = new URL(container.getConnectionUri());
      url.username = "openmapx_api";
      url.password = passwords.api;
      apiUrl = url.toString();
      root = mkdtempSync(join(tmpdir(), "omx-extension-migrations-pg-"));
      vi.stubEnv("DATABASE_URL", apiUrl);
      pools = await import("../db/index");
      migrations = await import("../extension-migrations");
      integrationDb = await import("../integration-db");
      ({ processLogger } = await import("../process-logger"));
    }, 240_000);

    beforeEach(async () => {
      await raw.unsafe(
        "drop schema if exists ext_demo cascade; drop schema if exists ext_manual cascade",
      );
      await raw`delete from extension_migration`;
      for (const table of STRAY_PUBLIC_TABLES)
        await raw.unsafe(`drop table if exists public.${table}`);
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
      try {
        await Promise.allSettled([
          pools?.sql.end({ timeout: 5 }),
          pools?.integrationSql.end({ timeout: 5 }),
          pools?.extensionSql.end({ timeout: 5 }),
          api?.end({ timeout: 5 }),
          raw?.end({ timeout: 5 }),
        ]);
      } finally {
        await container?.stop();
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

    it("resolves PostGIS names in migrations and in ctx.db without a prefix", async () => {
      expect(
        await migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql":
              "create table places (id int, geom geometry(Point, 4326)); create index places_geom_idx on places using gist (geom);",
          }),
        ),
      ).toEqual({ applied: ["0001_init.sql"], schemaAhead: false });
      const db = demoDb();
      const point = "select st_astext(st_makepoint(1, 2)) as p";

      expect(await db.execute(point)).toEqual([{ p: "POINT(1 2)" }]);
      expect(await db.transaction((tx) => tx.execute(point))).toEqual([{ p: "POINT(1 2)" }]);
      await db.transaction((tx) =>
        tx.execute("insert into places values (1, st_setsrid(st_makepoint(1, 2), 4326))"),
      );
      expect(await raw`select extensions.st_astext(geom) as p from ext_demo.places`).toEqual([
        { p: "POINT(1 2)" },
      ]);
    });

    it("never resolves an unqualified name to a platform table in public", async () => {
      await api`create table public.shadowed (id int)`;

      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": `${INIT}\ninsert into shadowed values (1);` }),
        ),
      ).rejects.toThrow(
        'Migration 0001_init.sql of demo failed at line 2: relation "shadowed" does not exist',
      );
      await migrations.applyExtensionMigrations(args());
      await expect(demoDb().execute("select * from shadowed")).rejects.toThrow(
        'relation "shadowed" does not exist',
      );
      expect(await demoDb().execute("select current_setting('search_path') as path")).toEqual([
        { path: '"ext_demo", extensions' },
      ]);
      expect(await raw`select count(*)::int as n from public.shadowed`).toEqual([{ n: 0 }]);
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

    it("applies nothing when one file fails, and names the file and line", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": INIT,
            "0002_index.sql": "-- the label index\n\ncreate index on;\n",
          }),
        ),
      ).rejects.toThrow(
        'Migration 0002_index.sql of demo failed at line 3: syntax error at or near ";"',
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it.each([
      ["COMMIT", "commit;"],
      ["ROLLBACK", "rollback;"],
      ["BEGIN", "begin;"],
      ["SAVEPOINT", "savepoint inner_step;"],
      ["COMMIT in a DO block", "do $$ begin commit; end $$;"],
    ])(
      "refuses a file that controls the transaction (%s) and leaves nothing behind",
      async (_label, control) => {
        await expect(
          migrations.applyExtensionMigrations(
            shipping({
              "0001_init.sql": INIT,
              "0002_bad.sql": `create table a (id int); ${control} create table later (id int);`,
              "0003_after.sql": "create table c (id int);",
            }),
          ),
        ).rejects.toThrow(
          "Migration 0002_bad.sql of demo may not end or start a transaction (COMMIT, ROLLBACK, BEGIN, SAVEPOINT); all migrations of a start run in one transaction",
        );
        expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
      },
    );

    it.each([
      ["CREATE INDEX CONCURRENTLY", "create index concurrently items_label_idx on items (label);"],
      ["VACUUM", "vacuum items;"],
    ])("refuses %s with a message that says why", async (_label, statement) => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": INIT, "0002_index.sql": statement }),
        ),
      ).rejects.toThrow(
        "Migration 0002_index.sql of demo contains a statement that cannot run inside a transaction, such as CREATE INDEX CONCURRENTLY or VACUUM",
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it("applies files that define functions and DO blocks with dollar quoting", async () => {
      await migrations.applyExtensionMigrations(
        shipping({
          "0001_init.sql": [
            "-- a comment; with a semicolon",
            INIT,
            "create function next_id() returns int language sql as $$ select coalesce(max(id), 0) + 1 from items; $$;",
            "create function label_of(i int) returns text language plpgsql as $body$",
            "begin return (select label from items where id = i); end",
            "$body$;",
            "do $$ begin insert into items values (next_id(), 'first; not a break'); end $$;",
          ].join("\n"),
        }),
      );

      expect(await demoDb().execute("select label_of(1) as label, next_id() as next")).toEqual([
        { label: "first; not a break", next: 2 },
      ]);
    });

    it("applies a large file", async () => {
      const rows = Array.from(
        { length: 20_000 },
        (_, i) => `insert into items values (${i}, 'row ${i}');`,
      );
      await migrations.applyExtensionMigrations(
        shipping({ "0001_init.sql": [INIT, ...rows].join("\n") }),
      );

      expect(await raw`select count(*)::int as n from ext_demo.items`).toEqual([{ n: 20_000 }]);
    }, 60_000);

    it("points every file at the integration's schema, whatever the file before set", async () => {
      expect(
        await migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": `${INIT} set search_path = public, extensions; set lock_timeout = 0; set transaction_timeout = 0;`,
            "0002_next.sql":
              "create table y (id int); create table settings as select current_setting('search_path') as path, current_setting('lock_timeout') as lock, current_setting('transaction_timeout') as total;",
          }),
        ),
      ).toEqual({ applied: ["0001_init.sql", "0002_next.sql"], schemaAhead: false });

      expect(
        await raw`select to_regclass('ext_demo.y') is not null as in_schema,
          to_regclass('public.y') is null as not_public`,
      ).toEqual([{ in_schema: true, not_public: true }]);
      expect(await raw`select path, lock, total from ext_demo.settings`).toEqual([
        { path: '"ext_demo", extensions', lock: "2min", total: "30min" },
      ]);
    });

    it("returns to the session's settings after each file, so the runner's own statements run under them", async () => {
      expect(
        await migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": `${INIT} set statement_timeout = 1; set search_path = public;`,
            "0002_next.sql": "select pg_sleep(0.05); create table y (id int);",
          }),
        ),
      ).toEqual({ applied: ["0001_init.sql", "0002_next.sql"], schemaAhead: false });
      expect(
        await raw`select to_regclass('ext_demo.y') is not null as in_schema,
          to_regclass('public.y') is null as not_public`,
      ).toEqual([{ in_schema: true, not_public: true }]);
    });

    it("names the file when what it left behind fails the runner's own statements", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": INIT,
            "0002_read_only.sql": "set transaction_read_only = on;",
          }),
        ),
      ).rejects.toThrow(
        "Migration 0002_read_only.sql of demo failed: cannot execute INSERT in a read-only transaction",
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it.each([
      ["RESET ALL", "reset all;"],
      ["RESET search_path", "reset search_path;"],
      ["SET search_path TO DEFAULT", "set search_path to default;"],
    ])("keeps a file in its schema after the file runs %s", async (_label, reset) => {
      await migrations.applyExtensionMigrations(
        shipping({ "0001_init.sql": `${reset} create table stray (id int);` }),
      );
      expect(
        await raw`select to_regclass('ext_demo.stray') is not null as in_schema,
          to_regclass('public.stray') is null as not_public`,
      ).toEqual([{ in_schema: true, not_public: true }]);
    });

    it("gives the migration session server-side limits that outlive the API process", async () => {
      await migrations.applyExtensionMigrations({
        ...shipping({
          "0001_init.sql":
            "create table settings as select current_setting('lock_timeout') as lock, current_setting('transaction_timeout') as total;",
        }),
        limits: { lockTimeoutMs: 3_000, deadlineMs: 7_000 },
      });

      expect(await raw`select lock, total from ext_demo.settings`).toEqual([
        { lock: "3s", total: "7s" },
      ]);
    });

    const DECLARE =
      "declare ON DELETE CASCADE, or store the id without a foreign key and erase the rows through the subject-data handler,";
    const SO_DELETION_WORKS =
      "so the platform can still delete the rows it references, for example an account";

    it.each([
      [
        "no ON DELETE",
        'create table notes (id int primary key, user_id text not null references public."user"(id), body text);',
        `foreign key notes_user_id_fkey on ext_demo.notes to public."user" with ON DELETE NO ACTION; ${DECLARE} ${SO_DELETION_WORKS}`,
      ],
      [
        "ON DELETE RESTRICT",
        "create table visits (session_id text references public.session(id) on delete restrict);",
        "foreign key visits_session_id_fkey on ext_demo.visits to public.session with ON DELETE RESTRICT",
      ],
      [
        "ON DELETE SET DEFAULT",
        `create table visits (user_id text default 'gone' references public."user"(id) on delete set default);`,
        'foreign key visits_user_id_fkey on ext_demo.visits to public."user" with ON DELETE SET DEFAULT',
      ],
      [
        "a key to another integration's schema",
        "create table visits (thing int references ext_manual.things(id));",
        "foreign key visits_thing_fkey on ext_demo.visits to ext_manual.things with ON DELETE NO ACTION",
      ],
    ])(
      "refuses a key out of the schema with %s, and leaves nothing behind",
      async (_label, table, refusal) => {
        await api.unsafe(
          "create schema ext_manual; create table ext_manual.things (id int primary key);",
        );
        await expect(
          migrations.applyExtensionMigrations(
            shipping({ "0001_init.sql": INIT, "0002_visits.sql": table }),
          ),
        ).rejects.toThrow(`Migration 0002_visits.sql of demo adds ${refusal}`);
        expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
      },
    );

    it("names the file that added a refused key when later files of the run follow it", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": 'create table notes (user_id text references public."user"(id));',
            "0002_index.sql": "create index notes_user_idx on notes (user_id);",
          }),
        ),
      ).rejects.toThrow(
        'Migration 0001_init.sql of demo adds foreign key notes_user_id_fkey on ext_demo.notes to public."user" with ON DELETE NO ACTION',
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it.each([
      [
        "on a NOT NULL column",
        'create table notes (user_id text not null references public."user"(id) on delete set null);',
      ],
      [
        "with a column list on a NOT NULL column",
        'create table notes (user_id text not null, foreign key (user_id) references public."user"(id) on delete set null (user_id));',
      ],
      [
        "on a nullable column",
        'create table notes (user_id text references public."user"(id) on delete set null);',
      ],
      [
        "with a column list whose other columns are NOT NULL",
        'create table notes (user_id text, org text not null, foreign key (user_id) references public."user"(id) on delete set null (user_id));',
      ],
    ])("refuses ON DELETE SET NULL %s out of the schema", async (_label, table) => {
      await expect(
        migrations.applyExtensionMigrations(shipping({ "0001_init.sql": table })),
      ).rejects.toThrow(
        `Migration 0001_init.sql of demo adds foreign key notes_user_id_fkey on ext_demo.notes to public."user" with ON DELETE SET NULL; ${DECLARE} ${SO_DELETION_WORKS}`,
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it.each([
      [
        "a unique column another key references",
        [
          'create table profiles (user_id text unique references public."user"(id) on delete set null);',
          "create table posts (author text references profiles(user_id));",
        ],
        "profiles_user_id_fkey on ext_demo.profiles",
      ],
      [
        "a column of a MATCH FULL key",
        [
          "create table memberships (user_id text, org int, primary key (user_id, org));",
          'create table t (user_id text references public."user"(id) on delete set null, org int, foreign key (user_id, org) references memberships (user_id, org) match full);',
        ],
        "t_user_id_fkey on ext_demo.t",
      ],
      [
        "a column whose domain forbids null",
        [
          "create domain uid as text not null;",
          'create table t (user_id uid references public."user"(id) on delete set null);',
        ],
        "t_user_id_fkey on ext_demo.t",
      ],
      [
        "a column a NOT NULL generated column is computed from",
        [
          'create table t (user_id text references public."user"(id) on delete set null, k text not null generated always as (user_id) stored);',
        ],
        "t_user_id_fkey on ext_demo.t",
      ],
    ])(
      "refuses ON DELETE SET NULL on %s, which would make deleting the account fail",
      async (_label, statements, key) => {
        await expect(
          migrations.applyExtensionMigrations(shipping({ "0001_init.sql": statements.join("\n") })),
        ).rejects.toThrow(
          `Migration 0001_init.sql of demo adds foreign key ${key} to public."user" with ON DELETE SET NULL; ${DECLARE}`,
        );
        expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
      },
    );

    it("names the file whose deferred key a row of it violates", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": INIT,
            "0002_deferred.sql": [
              "create table b (item_id int references items(id) on delete cascade deferrable initially deferred);",
              "insert into b values (5);",
            ].join("\n"),
          }),
        ),
      ).rejects.toThrow(
        'Migration 0002_deferred.sql of demo failed: insert or update on table "b" violates foreign key constraint "b_item_id_fkey"',
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it("refuses a key without ON DELETE to a table that cascades from a platform table", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": [
              'create table notes (id int primary key, user_id text not null references public."user"(id) on delete cascade);',
              "create table tags (note_id int not null references notes(id), label text);",
            ].join("\n"),
          }),
        ),
      ).rejects.toThrow(
        `Migration 0001_init.sql of demo adds foreign key tags_note_id_fkey on ext_demo.tags to ext_demo.notes with ON DELETE NO ACTION; rows of ext_demo.notes are deleted by a cascade from public."user" through notes_user_id_fkey; ${DECLARE} ${SO_DELETION_WORKS}`,
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it("follows a cascade three tables deep", async () => {
      await expect(
        migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": [
              'create table notes (id int primary key, user_id text not null references public."user"(id) on delete cascade);',
              "create table tags (id int primary key, note_id int not null references notes(id) on delete cascade);",
              "create table votes (tag_id int references tags(id) on delete set null);",
            ].join("\n"),
          }),
        ),
      ).rejects.toThrow(
        `Migration 0001_init.sql of demo adds foreign key votes_tag_id_fkey on ext_demo.votes to ext_demo.tags with ON DELETE SET NULL; rows of ext_demo.tags are deleted by a cascade from public."user" through notes_user_id_fkey, tags_note_id_fkey; ${DECLARE}`,
      );
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    });

    it("refuses a key that a later file adds to a table an earlier file created", async () => {
      const notes = [
        'create table notes (id int primary key, user_id text not null references public."user"(id) on delete cascade);',
        "create table tags (note_id int, label text);",
      ].join("\n");
      const addKey =
        "alter table tags add constraint tags_note_fkey foreign key (note_id) references notes(id) on delete restrict;";
      const refusal =
        'Migration 0002_key.sql of demo adds foreign key tags_note_fkey on ext_demo.tags to ext_demo.notes with ON DELETE RESTRICT; rows of ext_demo.notes are deleted by a cascade from public."user" through notes_user_id_fkey';

      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": notes, "0002_key.sql": addKey }),
        ),
      ).rejects.toThrow(refusal);
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });

      await migrations.applyExtensionMigrations(shipping({ "0001_init.sql": notes }));
      await expect(
        migrations.applyExtensionMigrations(
          shipping({ "0001_init.sql": notes, "0002_key.sql": addKey }),
        ),
      ).rejects.toThrow(refusal);
      expect(await leftBehind()).toEqual({ schema: true, rows: 1, stray: null });
    });

    it.each([
      [
        "in the same file",
        {
          "0001_init.sql": [
            "create table p (id int primary key, uid text) partition by range (id);",
            "create table p1 partition of p for values from (0) to (100);",
            'alter table p1 add constraint p1_uid_fkey foreign key (uid) references public."user"(id) on delete cascade;',
            "create table x (pid int references p(id));",
          ].join("\n"),
        },
        "0001_init.sql",
      ],
      [
        "when a later file attaches the partition",
        {
          "0001_init.sql": [
            "create table p (id int primary key, uid text) partition by range (id);",
            "create table x (pid int references p(id));",
          ].join("\n"),
          "0002_attach.sql": [
            'create table p1 (id int not null, uid text constraint p1_uid_fkey references public."user"(id) on delete cascade);',
            "alter table p attach partition p1 for values from (0) to (100);",
          ].join("\n"),
        },
        "0002_attach.sql",
      ],
    ])(
      "refuses a key to a partitioned table whose partition alone cascades from a platform table, %s",
      async (_label, files, file) => {
        await expect(migrations.applyExtensionMigrations(shipping(files))).rejects.toThrow(
          `Migration ${file} of demo adds foreign key x_pid_fkey on ext_demo.x to ext_demo.p1 with ON DELETE NO ACTION; rows of ext_demo.p1 are deleted by a cascade from public."user" through p1_uid_fkey; ${DECLARE} ${SO_DELETION_WORKS}`,
        );
        expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
      },
    );

    it("lets the account be deleted when every key to a cascading partitioned table cascades", async () => {
      await migrations.applyExtensionMigrations(
        shipping({
          "0001_init.sql": [
            "create table p (id int primary key, uid text) partition by range (id);",
            "create table p1 partition of p for values from (0) to (100);",
            'alter table p1 add constraint p1_uid_fkey foreign key (uid) references public."user"(id) on delete cascade;',
            "create table x (pid int references p(id) on delete cascade) partition by range (pid);",
            "create table x1 partition of x for values from (0) to (100);",
          ].join("\n"),
        }),
      );
      await raw`insert into "user" (id, name, email, role, created_at, updated_at)
        values ('part-owner', 'Owner', 'part-owner@example.test', 'user', now(), now())`;
      await raw.unsafe(
        "insert into ext_demo.p values (1, 'part-owner'); insert into ext_demo.x values (1);",
      );

      await deleteAccount("part-owner");

      expect(
        await raw`select (select count(*)::int from ext_demo.p) as p,
          (select count(*)::int from ext_demo.x) as x`,
      ).toEqual([{ p: 0, x: 0 }]);
    });

    it("lets the account be deleted through the erasure path with every accepted shape", async () => {
      expect(
        await migrations.applyExtensionMigrations(
          shipping({
            "0001_init.sql": [
              'create table notes (id int primary key, parent_id int references notes(id) on delete cascade, user_id text not null references public."user"(id) on delete cascade);',
              "create table tags (id int primary key, note_id int not null references notes(id) on delete cascade deferrable initially deferred);",
              "create table votes (tag_id int not null references tags(id) on delete cascade, label text not null);",
              "create table labels (id int primary key, name text not null);",
              "create table label_uses (label_id int not null references labels(id), note_id int references notes(id) on delete cascade);",
              "create table label_aliases (label_id int references labels(id) on delete set null, alias text not null);",
            ].join("\n"),
            "0002_more.sql": [
              'create table pins (owner text not null, note_id int, foreign key (owner) references public."user"(id) on delete cascade);',
              "alter table pins add constraint pins_note_fkey foreign key (note_id) references notes(id) on delete cascade;",
              "create table visits (session_id text not null references public.session(id) on delete cascade, at timestamptz);",
              'create table authors (user_id text unique not null references public."user"(id) on delete cascade, bio text);',
              "create table posts (author text not null references authors(user_id) on delete cascade, body text);",
            ].join("\n"),
          }),
        ),
      ).toEqual({ applied: ["0001_init.sql", "0002_more.sql"], schemaAhead: false });
      await raw`insert into "user" (id, name, email, role, created_at, updated_at)
        values ('note-owner', 'Owner', 'note-owner@example.test', 'user', now(), now())`;
      await raw.unsafe(`
        insert into ext_demo.notes (id, parent_id, user_id) values (1, null, 'note-owner'), (2, 1, 'note-owner');
        insert into ext_demo.tags (id, note_id) values (10, 2);
        insert into ext_demo.votes (tag_id, label) values (10, 'up');
        insert into ext_demo.labels (id, name) values (1, 'kept');
        insert into ext_demo.label_uses (label_id, note_id) values (1, 1);
        insert into ext_demo.label_aliases (label_id, alias) values (1, 'alias');
        insert into ext_demo.authors (user_id, bio) values ('note-owner', 'bio');
        insert into ext_demo.posts (author, body) values ('note-owner', 'post');`);
      await api`insert into "user" (id, name, email, role, created_at, updated_at)
        values ('pin-owner', 'Pins', 'pin-owner@example.test', 'user', now(), now())`;
      await raw`insert into ext_demo.pins (owner, note_id) values ('pin-owner', null)`;

      await deleteAccount("note-owner");

      expect(
        await raw`select (select count(*)::int from ext_demo.notes) as notes,
          (select count(*)::int from ext_demo.tags) as tags,
          (select count(*)::int from ext_demo.votes) as votes,
          (select count(*)::int from ext_demo.labels) as labels,
          (select count(*)::int from ext_demo.label_uses) as label_uses,
          (select count(*)::int from ext_demo.label_aliases) as label_aliases,
          (select count(*)::int from ext_demo.authors) as authors,
          (select count(*)::int from ext_demo.posts) as posts,
          (select json_agg(owner) from ext_demo.pins) as pins,
          (select count(*)::int from "user" where id = 'note-owner') as users`,
      ).toEqual([
        {
          notes: 0,
          tags: 0,
          votes: 0,
          labels: 1,
          label_uses: 0,
          label_aliases: 1,
          authors: 0,
          posts: 0,
          pins: ["pin-owner"],
          users: 0,
        },
      ]);
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
      const holder = postgres(apiUrl, { max: 1 });
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
          where application_name = 'openmapx-api-migrations'`,
      ).toEqual([{ n: 0 }]);
    }, 30_000);

    it("cancels running migrations on request, rolls them back and releases their lock", async () => {
      // The cancel also refuses every later run, so it gets a module of its
      // own; the other tests keep theirs.
      vi.resetModules();
      const stopping = await import("../extension-migrations");
      const running = stopping.applyExtensionMigrations(
        shipping({ "0001_init.sql": `${INIT} select pg_sleep(60);` }),
      );
      running.catch(() => {});
      await vi.waitFor(
        async () =>
          expect(
            await raw`select count(*)::int as n from pg_stat_activity
              where application_name = 'openmapx-api-migrations' and wait_event = 'PgSleep'`,
          ).toEqual([{ n: 1 }]),
        { timeout: 10_000, interval: 100 },
      );
      const started = Date.now();

      await stopping.cancelRunningExtensionMigrations();

      await expect(running).rejects.toThrow("Migrations of demo were cancelled");
      await expect(stopping.applyExtensionMigrations(args())).rejects.toThrow(
        "Migrations of demo were cancelled because the API is stopping",
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
      expect(
        await raw`select count(*)::int as n from pg_stat_activity
          where application_name = 'openmapx-api-migrations'`,
      ).toEqual([{ n: 0 }]);
    }, 30_000);

    it("removes an integration's schema and bookkeeping, and a reinstall starts from 0001", async () => {
      await migrations.applyExtensionMigrations(args());
      await raw`insert into integration_task_run (integration_id, task_name, status, finished_at)
        values ('demo', 'sync', 'succeeded', now()), ('other', 'sync', 'succeeded', now())`;
      await raw`insert into subject_erasure_pending (integration_id, subject_user_id)
        values ('demo', 'u1'), ('demo', 'u2'), ('other', 'u1')`;
      await raw`insert into integration_subject_handler (integration_id) values ('demo')`;
      await raw`insert into attention_item (key, severity, source, title) values
        ('subject-erasure-pending:demo', 'warning', 'privacy', 'Erasure pending in Demo'),
        ('integration-schema-ahead:demo', 'warning', 'integrations', 'Demo runs against a newer database schema'),
        ('subject-erasure-pending:other', 'warning', 'privacy', 'Erasure pending in Other')`;
      const warn = vi.spyOn(processLogger, "warn");

      const removed = await api.begin((tx) => migrations.removeIntegrationData(tx, "demo"));
      expect(removed).toMatchObject({ schema: "ext_demo", droppedErasures: 2 });
      // Nothing is resolved before the caller's transaction has committed.
      expect(await raw`select key from attention_item order by key`).toHaveLength(3);
      await removed.afterCommit();

      expect(await raw`select key from attention_item order by key`).toEqual([
        { key: "subject-erasure-pending:other" },
      ]);
      expect(warn).toHaveBeenCalledWith(
        { integrationId: "demo", dropped: 2 },
        "Dropped 2 owed erasures of integration demo: its data was removed",
      );
      warn.mockRestore();
      await raw`delete from attention_item`;
      await raw`delete from subject_erasure_pending`;

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

    it("waits with a removal for a migration of the same integration that is running", async () => {
      const finished: string[] = [];
      const migration = migrations
        .applyExtensionMigrations(shipping({ "0001_init.sql": `${INIT} select pg_sleep(3);` }))
        .then(() => finished.push("migration"));
      await vi.waitFor(
        async () =>
          expect(
            await raw`select count(*)::int as n from pg_stat_activity
              where application_name = 'openmapx-api-migrations' and wait_event = 'PgSleep'`,
          ).toEqual([{ n: 1 }]),
        { timeout: 10_000, interval: 50 },
      );

      const removal = api
        .begin((tx) => migrations.removeIntegrationData(tx, "demo"))
        .then(() => finished.push("removal"));
      await Promise.all([migration, removal]);

      expect(finished).toEqual(["migration", "removal"]);
      expect(await leftBehind()).toEqual({ schema: false, rows: 0, stray: null });
    }, 30_000);

    it("refuses the database calls of a removed integration and touches nothing in public", async () => {
      await migrations.applyExtensionMigrations(args());
      const loaded = demoDb();
      expect(await loaded.execute("select count(*)::int as n from items")).toEqual([{ n: 0 }]);

      await api.begin((tx) => migrations.removeIntegrationData(tx, "demo"));

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
