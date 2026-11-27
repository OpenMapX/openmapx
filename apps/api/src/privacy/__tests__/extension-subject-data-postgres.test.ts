import { randomUUID } from "node:crypto";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

class Rollback extends Error {}

function integration(id: string, name: string): LoadedIntegration {
  return {
    id,
    manifest: { id, name } as LoadedIntegration["manifest"],
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: false,
    enabled: true,
    providers: new Map(),
    strings: {},
    loadState: "loaded",
    shutdownHandlers: [],
  };
}

describe.skipIf(skipDatabase)("extension subject data in PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let raw: Sql;
  let pools: typeof import("../../db/index");
  let subjectData: typeof import("../extension-subject-data");
  let handlers: typeof import("../extension-handlers");
  let registry: LoadedIntegration[];
  /** The integration that owns `ext_notes` and erases through its `ctx.db`. */
  let notes: LoadedIntegration;
  let eraseNotes: Mock<(subjectId: string) => Promise<void>>;

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    raw = fixture.sql;
    vi.stubEnv("DATABASE_URL", fixture.connectionUri);
    pools = await import("../../db/index");
    subjectData = await import("../extension-subject-data");
    handlers = await import("../extension-handlers");
    const { createIntegrationDb, integrationDbAccess } = await import("../../integration-db");
    await raw`create schema ext_notes`;
    await raw`create table ext_notes.note (user_id text not null, body text not null)`;
    const ctxDb = createIntegrationDb(
      { requests: pools.integrationSql, transactions: pools.extensionSql },
      integrationDbAccess({ id: "notes", database: { migrations: true } }),
    );
    notes = integration("notes", "Notes");
    eraseNotes = vi.fn(async (subjectId: string) => {
      await ctxDb.transaction((tx) =>
        tx.execute("delete from note where user_id = $1", [subjectId]),
      );
    });
    handlers.registerSubjectDataHandlerFor(
      notes,
      { integrationId: "notes", isBuiltIn: false, revoked: false },
      { erase: (subjectId) => eraseNotes(subjectId), export: async () => null },
    );
    registry = [notes];
    handlers.setSubjectDataIntegrationSource(() => registry);
  }, 180_000);

  afterAll(async () => {
    handlers?.setSubjectDataIntegrationSource(null);
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

  beforeEach(async () => {
    registry = [notes];
    eraseNotes.mockClear();
    await raw`delete from subject_erasure_pending`;
    await raw`delete from integration_subject_handler`;
    await raw`delete from attention_item`;
    await raw`delete from ext_notes.note`;
  });

  async function createUser(): Promise<string> {
    const id = `subject-${randomUUID()}`;
    await raw`insert into "user" (id, name, email) values (${id}, 'Subject', ${`${id}@example.test`})`;
    return id;
  }

  async function pendingRows(integrationId: string) {
    return raw<Array<{ integration_id: string; subject_user_id: string; attempts: number }>>`
      select integration_id, subject_user_id, attempts from subject_erasure_pending
      where integration_id = ${integrationId} order by subject_user_id`;
  }

  async function handlerRows(): Promise<string[]> {
    const rows = await raw<Array<{ integration_id: string }>>`
      select integration_id from integration_subject_handler order by integration_id`;
    return rows.map((row) => row.integration_id);
  }

  it("records a pending row for each listed integration when a user is deleted by plain SQL", async () => {
    const userId = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('a')`;

    // The restore replay deletes with the same statement.
    await raw`delete from "user" where id = ${userId}`;

    expect(await pendingRows("a")).toEqual([
      { integration_id: "a", subject_user_id: userId, attempts: 0 },
    ]);
  });

  it("keeps the attempts of a row that is recorded again", async () => {
    const userId = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('a')`;
    await raw`insert into subject_erasure_pending (integration_id, subject_user_id, attempts, last_error)
      values ('a', ${userId}, 2, 'boom')`;

    await raw`delete from "user" where id = ${userId}`;

    expect(await pendingRows("a")).toEqual([
      { integration_id: "a", subject_user_id: userId, attempts: 2 },
    ]);
  });

  it("records nothing when the deletion rolls back", async () => {
    const userId = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('a')`;

    await raw
      .begin(async (tx) => {
        await tx`delete from "user" where id = ${userId}`;
        throw new Rollback();
      })
      .catch(() => {});

    expect(await pendingRows("a")).toEqual([]);
  });

  it("unlists only an integration that runs without a handler, and resolves its item", async () => {
    await raw`insert into integration_subject_handler (integration_id) values ('b'), ('gone')`;
    await raw`insert into subject_erasure_pending (integration_id, subject_user_id)
      values ('b', 'u1'), ('b', 'u2'), ('gone', 'u1')`;
    await raw`insert into attention_item (key, severity, source, title)
      values ('subject-erasure-pending:b', 'warning', 'privacy', 'Erasure pending in Without handler')`;
    registry = [notes, integration("b", "Without handler")];

    await subjectData.syncSubjectHandlerTable();

    expect(await handlerRows()).toEqual(["gone", "notes"]);
    expect(await pendingRows("b")).toEqual([]);
    expect(await pendingRows("gone")).toHaveLength(1);
    expect(await raw`select key from attention_item`).toEqual([]);
  });

  it("resolves a schema-ahead item whose integration's data was removed", async () => {
    await raw`delete from extension_migration where integration_id in ('removed', 'kept')`;
    await raw`insert into extension_migration (integration_id, name, sha256)
      values ('kept', '0002_newer.sql', ${"a".repeat(64)})`;
    await raw`insert into attention_item (key, severity, source, title) values
      ('integration-schema-ahead:removed', 'warning', 'extensions', 'Removed runs against a newer database schema'),
      ('integration-schema-ahead:kept', 'warning', 'extensions', 'Kept runs against a newer database schema')`;
    try {
      await subjectData.syncSubjectHandlerTable();

      expect(await raw`select key from attention_item order by key`).toEqual([
        { key: "integration-schema-ahead:kept" },
      ]);
    } finally {
      await raw`delete from extension_migration where integration_id = 'kept'`;
    }
  });

  it("keeps recording deletions for an installed integration the registry no longer holds", async () => {
    const first = await createUser();
    const second = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('skipped')`;
    await raw`delete from "user" where id = ${first}`;

    // The loader left it out, for example because its manifest failed a check.
    await subjectData.syncSubjectHandlerTable();
    await raw`delete from "user" where id = ${second}`;

    expect((await pendingRows("skipped")).map((row) => row.subject_user_id).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("shows the erasures an integration that cannot run owes, and clears the item once none are left", async () => {
    const userId = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('tracker')`;
    await raw`delete from "user" where id = ${userId}`;
    registry = [notes, { ...integration("tracker", "Tracker"), loadState: "failed" }];

    await subjectData.runPendingErasures();

    expect(await raw`select key, severity, source, title, detail from attention_item`).toEqual([
      {
        key: "subject-erasure-pending:tracker",
        severity: "warning",
        source: "privacy",
        title: "Erasure pending in Tracker",
        detail:
          "Tracker cannot erase data now: it failed to load. 1 deleted account waits for it to erase their data. Repair or update the extension, or remove its data.",
      },
    ]);

    await raw`delete from subject_erasure_pending where integration_id = 'tracker'`;
    await subjectData.runPendingErasures();
    expect(await raw`select key from attention_item`).toEqual([]);
  });

  it("works off the accounts whose erase failed least often first", async () => {
    await raw`insert into subject_erasure_pending (integration_id, subject_user_id, attempts, requested_at)
      values ('notes', 'often-failed', 3, now() - interval '2 days'),
             ('notes', 'never-tried', 0, now() - interval '1 day')`;
    const store = subjectData.createSubjectErasureStore(pools.db);

    expect(await store.pendingSubjects("notes")).toEqual(["never-tried", "often-failed"]);
  });

  it("lets the server end an erase transaction that stays idle past its limit", async () => {
    const userId = await createUser();
    await raw`insert into integration_subject_handler (integration_id) values ('stuck')`;
    await raw`delete from "user" where id = ${userId}`;
    const store = subjectData.createSubjectErasureStore(pools.db, { idleLimitMs: 1_000 });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const erasing = store.eraseLocked("stuck", userId, async () => {
      locked();
      await held;
      return { ok: true };
    });
    erasing.catch(() => {});
    await holding;
    try {
      // While the call still waits, the server has ended the transaction and
      // freed the row.
      await vi.waitFor(
        async () => {
          await raw.begin(async (tx) => {
            await tx`set local lock_timeout = '200ms'`;
            await tx`select 1 from subject_erasure_pending where integration_id = 'stuck' for update`;
          });
        },
        { timeout: 5_000, interval: 250 },
      );
    } finally {
      release();
    }
    await expect(erasing).rejects.toThrow();
    expect(await pendingRows("stuck")).toHaveLength(1);
  }, 20_000);

  it("erases through an extension's ctx.db after the account is deleted and resolves its attention item", async () => {
    const userId = await createUser();
    const otherId = await createUser();
    await raw`insert into ext_notes.note (user_id, body)
      values (${userId}, 'mine'), (${userId}, 'also mine'), (${otherId}, 'not mine')`;
    await subjectData.syncSubjectHandlerTable();
    await raw`insert into attention_item (key, severity, source, title)
      values ('subject-erasure-pending:notes', 'warning', 'privacy', 'Erasure pending in Notes')`;

    await raw`delete from "user" where id = ${userId}`;
    expect(await subjectData.pendingErasureCount(["notes"])).toBe(1);
    expect(await subjectData.runPendingErasures()).toEqual({ erased: 1, failed: 0 });

    expect(eraseNotes).toHaveBeenCalledWith(userId);
    expect(await raw`select user_id, body from ext_notes.note`).toEqual([
      { user_id: otherId, body: "not mine" },
    ]);
    expect(await pendingRows("notes")).toEqual([]);
    expect(await raw`select key from attention_item`).toEqual([]);
  });

  it("raises an attention item and keeps the row when the handler fails", async () => {
    const userId = await createUser();
    await subjectData.syncSubjectHandlerTable();
    await raw`delete from "user" where id = ${userId}`;
    eraseNotes.mockRejectedValueOnce(new Error("boom"));

    expect(await subjectData.runPendingErasures("notes")).toEqual({ erased: 0, failed: 1 });

    expect(
      await raw`select attempts, last_error from subject_erasure_pending
        where integration_id = 'notes'`,
    ).toEqual([{ attempts: 1, last_error: "boom" }]);
    expect(await raw`select key, severity, source, title, detail from attention_item`).toEqual([
      {
        key: "subject-erasure-pending:notes",
        severity: "warning",
        source: "privacy",
        title: "Erasure pending in Notes",
        detail:
          "1 deleted account waits for this extension to erase their data; erasing has failed up to 1 time per account. Last error: boom. Repair or update the extension, or remove its data.",
      },
    ]);
  });

  it("calls erase once when two runs overlap", async () => {
    const userId = await createUser();
    await subjectData.syncSubjectHandlerTable();
    await raw`delete from "user" where id = ${userId}`;

    await Promise.all([
      subjectData.runPendingErasures("notes"),
      subjectData.runPendingErasures("notes"),
    ]);

    expect(eraseNotes).toHaveBeenCalledTimes(1);
    expect(await pendingRows("notes")).toEqual([]);
  });

  it("skips a row another transaction holds instead of waiting for it", async () => {
    const userId = await createUser();
    await subjectData.syncSubjectHandlerTable();
    await raw`delete from "user" where id = ${userId}`;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = raw.begin(async (tx) => {
      await tx`select 1 from subject_erasure_pending where integration_id = 'notes' for update`;
      locked();
      await released;
    });
    await holding;

    try {
      expect(await subjectData.runPendingErasures("notes")).toEqual({ erased: 0, failed: 0 });
      expect(eraseNotes).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
    }
    expect(await pendingRows("notes")).toHaveLength(1);
  });

  it("asks a loaded extension for the export and lists a listed one that cannot run", async () => {
    const userId = await createUser();
    await raw`insert into ext_notes.note (user_id, body) values (${userId}, 'mine')`;
    await raw`insert into integration_subject_handler (integration_id) values ('notes'), ('tracker')`;
    const tracker = { ...integration("tracker", "Tracker"), loadState: "failed" as const };
    const { createIntegrationDb, integrationDbAccess } = await import("../../integration-db");
    const ctxDb = createIntegrationDb(
      { requests: pools.integrationSql, transactions: pools.extensionSql },
      integrationDbAccess({ id: "notes", database: { migrations: true } }),
    );
    const exported = integration("notes", "Notes");
    handlers.registerSubjectDataHandlerFor(
      exported,
      { integrationId: "notes", isBuiltIn: false, revoked: false },
      {
        erase: async () => {},
        export: async (subjectId) => ({
          notes: await ctxDb.execute("select body from note where user_id = $1", [subjectId]),
        }),
      },
    );
    registry = [exported, tracker];

    const parts = await subjectData.collectExtensionSubjectData({
      requestId: "case-1",
      userId,
      database: pools.db,
    });

    expect(
      parts.map((part) => [part.extension?.integrationId, part.outcome, part.warningCodes]),
    ).toEqual([
      ["notes", "included", []],
      ["tracker", "unavailable", ["extension-not-loaded"]],
    ]);
    expect(JSON.parse(String(parts[0]?.entries?.[0]?.source))).toEqual({
      notes: [{ body: "mine" }],
    });
  });

  it("names an extension whose schema is still in the database though it is not installed", async () => {
    const userId = await createUser();
    await raw`create schema if not exists ext_kept_data`;
    await raw`create schema if not exists "ext_not_an_id_"`;
    try {
      registry = [notes];

      const parts = await subjectData.collectExtensionSubjectData({
        requestId: "case-2",
        userId,
        database: pools.db,
      });

      expect(
        parts.map((part) => [part.extension?.integrationId, part.outcome, part.warningCodes]),
      ).toEqual([
        ["notes", "included", []],
        ["kept-data", "unavailable", ["extension-not-installed"]],
      ]);
    } finally {
      await raw`drop schema ext_kept_data`;
      await raw`drop schema "ext_not_an_id_"`;
    }
  });

  it("does not take an ext_ schema of another owner for an extension's data", async () => {
    const userId = await createUser();
    await raw`do $$ begin
      if not exists (select from pg_roles where rolname = 'omx_foreign_owner') then
        create role omx_foreign_owner nologin;
      end if;
    end $$`;
    await raw`create schema if not exists ext_foreign_tool authorization omx_foreign_owner`;
    try {
      registry = [notes];

      const parts = await subjectData.collectExtensionSubjectData({
        requestId: "case-3",
        userId,
        database: pools.db,
      });

      expect(parts.map((part) => part.extension?.integrationId)).toEqual(["notes"]);
    } finally {
      await raw`drop schema ext_foreign_tool`;
    }
  });

  it("holds no lock or transaction past the deadline of a handler that never settles", async () => {
    const hung = integration("hung", "Hung");
    const { createExtensionSubjectData, createSubjectErasureStore } = subjectData;
    handlers.registerSubjectDataHandlerFor(
      hung,
      { integrationId: "hung", isBuiltIn: false, revoked: false },
      { erase: () => new Promise<void>(() => {}), export: async () => null },
    );
    const shortened = createExtensionSubjectData({
      store: createSubjectErasureStore(pools.db),
      integrations: () => [hung],
      attention: { raise: async () => {}, resolve: async () => {}, openKeys: async () => [] },
      log: { warn: () => {} },
      eraseDeadlineMs: 1_000,
    });
    await raw`insert into integration_subject_handler (integration_id) values ('hung')`;
    const firstId = await createUser();
    await raw`delete from "user" where id = ${firstId}`;

    const run = shortened.runPendingErasures();
    // While the handler hangs, another account can be deleted and is recorded.
    const secondId = await createUser();
    const started = Date.now();
    await raw`delete from "user" where id = ${secondId}`;
    expect(Date.now() - started).toBeLessThan(900);
    expect(await run).toEqual({ erased: 0, failed: 1 });

    expect(
      await raw`select subject_user_id, attempts, last_error from subject_erasure_pending
        where integration_id = 'hung' order by attempts desc`,
    ).toEqual([
      {
        subject_user_id: firstId,
        attempts: 1,
        last_error: "Erase did not finish within 1 seconds",
      },
      { subject_user_id: secondId, attempts: 0, last_error: null },
    ]);
    expect(
      await raw`select count(*)::int as n from pg_stat_activity
        where application_name = 'openmapx-api' and state like 'idle in transaction%'`,
    ).toEqual([{ n: 0 }]);
    // The row can be locked at once: nothing holds it.
    await raw.begin(async (tx) => {
      await tx`set local lock_timeout = '200ms'`;
      await tx`select 1 from subject_erasure_pending where integration_id = 'hung' for update`;
    });
  }, 20_000);
});
