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
    subjectData.registerSubjectDataHandlerFor(
      notes,
      { integrationId: "notes", isBuiltIn: false, revoked: false },
      { erase: (subjectId) => eraseNotes(subjectId), export: async () => null },
    );
    registry = [notes];
    subjectData.setSubjectDataIntegrationSource(() => registry);
  }, 180_000);

  afterAll(async () => {
    subjectData?.setSubjectDataIntegrationSource(null);
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

  it("syncs the handler table in one statement set against the live registry", async () => {
    await raw`insert into integration_subject_handler (integration_id) values ('b'), ('gone')`;
    await raw`insert into subject_erasure_pending (integration_id, subject_user_id)
      values ('b', 'u1'), ('gone', 'u1')`;
    registry = [notes, integration("b", "Without handler")];

    await subjectData.syncSubjectHandlerTable();

    expect(await handlerRows()).toEqual(["notes"]);
    expect(await pendingRows("b")).toEqual([]);
    expect(await pendingRows("gone")).toHaveLength(1);
  });

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
        detail: "boom",
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

  it("holds no lock or transaction past the deadline of a handler that never settles", async () => {
    const hung = integration("hung", "Hung");
    const { createExtensionSubjectData, createSubjectErasureStore, registerSubjectDataHandlerFor } =
      subjectData;
    registerSubjectDataHandlerFor(
      hung,
      { integrationId: "hung", isBuiltIn: false, revoked: false },
      { erase: () => new Promise<void>(() => {}), export: async () => null },
    );
    const shortened = createExtensionSubjectData({
      store: createSubjectErasureStore(pools.db),
      integrations: () => [hung],
      attention: { raise: async () => {}, resolve: async () => {} },
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
