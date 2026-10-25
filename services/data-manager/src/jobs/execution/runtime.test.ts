import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, existsSync as requireExists, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../state.js";
import { preserveTransitPending } from "../transitous/owned-ops.js";
import { buildJobContext } from "../transitous/pipeline.js";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";
import { publishDataChange, withDataSqlCancellation } from "./worker-scope.js";

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("real durable data runtime containment", () => {
  it.each(["committed", "canceled"] as const)(
    "retains cancel-pending and no final time until actual worker settles (%s)",
    async (outcome) => {
      const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
      if (!url) throw Error("Owned PostgreSQL required");
      const sql = postgres(url, { max: 4 });
      drizzle(sql);
      const root = mkdtempSync(join(tmpdir(), "omx-runtime-"));
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await control.provisionControlInstallation(root);
      const installation = control.openControlInstallation({
          infraDir: root,
          role: "data-manager",
          serviceIds: ["data-manager"],
        }),
        journal = control.createDataExecutionControlJournal(installation, sql),
        store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
      let release = () => {},
        started = () => {},
        aborted = () => {};
      const held = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          started = resolve;
        }),
        canceled = new Promise<void>((resolve) => {
          aborted = resolve;
        });
      let effects = 0;
      const runtime = createDataExecutionRuntime({
        store,
        dispatch: async (_input, context) => {
          effects++;
          started();
          context.signal.addEventListener("abort", aborted, { once: true });
          await held;
          if (outcome === "canceled") context.signal.throwIfAborted();
          return { kind: "download-fonts", completed: true };
        },
      });
      let id: string | undefined;
      let key: string | undefined;
      try {
        const deadline = Date.now() + 60000;
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
        const admitted = await runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
        id = admitted.id;
        await ready;
        const running = await store.inspect(id);
        await expect(
          store.checkpoint(id, running!.version, {
            status: "ok",
            publication: "committed",
            result: { kind: "download-fonts", completed: true },
          }),
        ).rejects.toThrow("Actual contained worker terminal commitment required");
        expect((await store.inspect(id))?.finishedAt).toBeNull();
        const duplicate = await runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
        expect(duplicate.id).toBe(id);
        expect(effects).toBe(1);
        const pending = await runtime.requestCancel({
          id,
          operationKey: key,
          fingerprint: admitted.fingerprint,
        });
        await canceled;
        expect(pending.status).toBe("cancel_pending");
        expect((await store.inspect(id))?.finishedAt).toBeNull();
        release();
        await expect
          .poll(async () => (await runtime.inspect(id!))?.status, { timeout: 15000 })
          .toBe(outcome === "committed" ? "ok" : "canceled");
        const terminal = await store.inspect(id);
        expect(terminal?.finishedAt).not.toBeNull();
        expect(terminal?.status.publication).toBe(
          outcome === "committed" ? "committed" : "not_started",
        );
        expect(
          (
            await runtime.requestCancel({
              id,
              operationKey: key,
              fingerprint: admitted.fingerprint,
            })
          ).status,
        ).toBe(terminal?.status.status);
        const proof = await journal.repairTerminal(terminal!.execution);
        expect(proof.execution).toEqual(terminal!.execution);
        await journal.publishTerminal(terminal!.execution);
        await expect(
          runtime.admit(
            { kind: "download-fonts" },
            { operationKey: key, requestedDeadlineAt: deadline + 1 },
          ),
        ).rejects.toThrow(/conflict/i);
      } finally {
        release();
        await runtime.close();
        if (!id && key) id = (await store.lookup(key))?.status.id;
        if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
        journal.close();
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("repairs a worker-completion/publication crash from the original signed completion without redispatch", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-data-completion-gap-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    let installation = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager"],
    });
    let journal = control.createDataExecutionControlJournal(installation, sql);
    let store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    let dispatches = 0;
    const broken = new Proxy(store, {
      get(target, key, receiver) {
        return key === "finalize"
          ? async () => {
              throw Error("Synthetic crash before terminal preparation");
            }
          : Reflect.get(target, key, receiver);
      },
    });
    let runtime = createDataExecutionRuntime({
        store: broken,
        dispatch: async () => {
          dispatches++;
          return { kind: "download-fonts", completed: true };
        },
      }),
      id: string | undefined,
      key: string | undefined;
    try {
      const deadline = Date.now() + 60000;
      key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      const admitted = await runtime.admit(
        { kind: "download-fonts" },
        { operationKey: key, requestedDeadlineAt: deadline },
      );
      id = admitted.id;
      await expect
        .poll(async () => (await store.inspect(id!))?.status.publication, { timeout: 15000 })
        .toBe("unknown");
      await runtime.close();
      journal.close();
      control.closeControlInstallation(installation);
      installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      });
      journal = control.createDataExecutionControlJournal(installation, sql);
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
      runtime = createDataExecutionRuntime({
        store,
        dispatch: async () => {
          dispatches++;
          throw Error("Old execution must never be replayed");
        },
      });
      await runtime.reconcile();
      expect((await store.inspect(id))?.status).toMatchObject({
        status: "ok",
        publication: "committed",
        result: { kind: "download-fonts", completed: true },
      });
      expect((await store.inspect(id))?.finishedAt).not.toBeNull();
      expect(dispatches).toBe(1);
      expect(
        (await import("node:fs")).existsSync(
          join(root, "data/.admin-target-control/locks/data-manager"),
        ),
      ).toBe(false);
      const recovered = await store.inspect(id);
      expect(
        control.verifyDataControlTerminalWitness(installation, recovered!.execution).status,
      ).toEqual(recovered!.status);
      await runtime.reconcile();
      expect(dispatches).toBe(1);
    } finally {
      await runtime.close();
      if (!id && key) id = (await store.lookup(key))?.status.id;
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
  it.each(["before-commit", "during-commit"] as const)(
    "cancels the actual owned PostgreSQL transaction (%s)",
    async (mode) => {
      const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
      if (!url) throw Error("Owned PostgreSQL required");
      const sql = postgres(url, { max: 5 }),
        workerSql = withDataSqlCancellation(sql),
        root = mkdtempSync(join(tmpdir(), "omx-data-transaction-"));
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await control.provisionControlInstallation(root);
      const installation = control.openControlInstallation({
          infraDir: root,
          role: "data-manager",
          serviceIds: ["data-manager"],
        }),
        journal = control.createDataExecutionControlJournal(installation, sql),
        store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
      const suffix = randomUUID().replaceAll("-", ""),
        parent = `task023_parent_${suffix}`,
        child = `task023_child_${suffix}`;
      await sql.unsafe(`CREATE TABLE data_manager.${parent}(id int PRIMARY KEY)`);
      await sql.unsafe(
        `CREATE TABLE data_manager.${child}(id int PRIMARY KEY,parent int REFERENCES data_manager.${parent}(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await sql.unsafe(`INSERT INTO data_manager.${parent} VALUES(1)`);
      let ready = () => {},
        unblock = () => {},
        locked = () => {},
        unlock = () => {},
        workerPid = 0;
      const workerReady = new Promise<void>((resolve) => {
          ready = resolve;
        }),
        held = new Promise<void>((resolve) => {
          unblock = resolve;
        }),
        lockerReady = new Promise<void>((resolve) => {
          locked = resolve;
        }),
        lockerHeld = new Promise<void>((resolve) => {
          unlock = resolve;
        });
      const locker =
        mode === "during-commit"
          ? sql
              .begin(async (tx) => {
                await tx.unsafe(`DELETE FROM data_manager.${parent} WHERE id=1`);
                locked();
                await lockerHeld;
                throw Error("Synthetic locker rollback");
              })
              .catch(() => undefined)
          : Promise.resolve();
      if (mode === "during-commit") await lockerReady;
      const runtime = createDataExecutionRuntime({
        store,
        dispatch: async () => {
          await publishDataChange(() =>
            workerSql.begin(async (tx) => {
              const pid = await tx`SELECT pg_backend_pid() AS pid`;
              workerPid = Number(pid[0]?.pid);
              await tx.unsafe(`INSERT INTO data_manager.${child} VALUES(1,1)`);
              ready();
              if (mode === "before-commit") await held;
            }),
          );
          return { kind: "download-fonts", completed: true };
        },
      });
      let id: string | undefined, key: string | undefined;
      try {
        const deadline = Date.now() + 60000;
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
        const admitted = await runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
        id = admitted.id;
        await workerReady;
        if (mode === "during-commit")
          await expect
            .poll(
              async () => {
                const rows =
                  await sql`SELECT query,wait_event_type FROM pg_stat_activity WHERE pid=${workerPid}`;
                return rows[0]?.query === "COMMIT" && rows[0]?.wait_event_type === "Lock";
              },
              { timeout: 10000 },
            )
            .toBe(true);
        const pending = await runtime.requestCancel({
          id,
          operationKey: key,
          fingerprint: admitted.fingerprint,
        });
        expect(pending.status).toBe("cancel_pending");
        expect((await store.inspect(id))?.finishedAt).toBeNull();
        if (mode === "before-commit") {
          unblock();
          await expect
            .poll(async () => (await store.inspect(id!))?.status.status, { timeout: 15000 })
            .toBe("canceled");
          expect((await store.inspect(id))?.status.publication).toBe("not_started");
        } else {
          await expect
            .poll(
              async () => {
                const rows = await sql`SELECT state FROM pg_stat_activity WHERE pid=${workerPid}`;
                return rows[0]?.state;
              },
              { timeout: 15000 },
            )
            .toBe("idle");
          expect((await store.inspect(id))?.status).toMatchObject({
            status: "cancel_pending",
            publication: "unknown",
          });
          expect((await store.inspect(id))?.finishedAt).toBeNull();
        }
        expect(
          (await sql.unsafe(`SELECT count(*)::int AS count FROM data_manager.${child}`))[0]?.count,
        ).toBe(0);
      } finally {
        unblock();
        unlock();
        await locker;
        await runtime.close();
        if (!id && key) id = (await store.lookup(key))?.status.id;
        if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
        await sql.unsafe(`DROP TABLE data_manager.${child}`);
        await sql.unsafe(`DROP TABLE data_manager.${parent}`);
        journal.close();
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60000,
  );

  it("retains partial publication and its original completion across restart without replay", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    drizzle(sql);
    const root = mkdtempSync(join(tmpdir(), "omx-data-partial-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    let installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal }),
      dispatches = 0;
    const broken = new Proxy(store, {
      get(target, key, receiver) {
        return key === "finalize"
          ? async () => {
              throw Error("Synthetic crash before partial terminal publication");
            }
          : Reflect.get(target, key, receiver);
      },
    });
    let runtime = createDataExecutionRuntime({
        store: broken,
        dispatch: async () => {
          dispatches++;
          throw new control.DataExecutionPartialResult({
            kind: "overture-sync",
            region: "europe/germany/berlin",
            release: "2026-07-22.0",
            metrics: { processed: 0 },
          });
        },
      }),
      id: string | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = await runtime.admit(
          { kind: "overture-sync", region: "europe/germany/berlin" },
          { operationKey: key, requestedDeadlineAt: deadline, triggeredBy: "cron" },
        );
      id = admitted.id;
      await expect.poll(async () => (await store.inspect(id!))?.status.publication).toBe("unknown");
      expect((await store.inspect(id))?.finishedAt).toBeNull();
      await runtime.close();
      journal.close();
      control.closeControlInstallation(installation);
      installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      });
      journal = control.createDataExecutionControlJournal(installation, sql);
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
      runtime = createDataExecutionRuntime({
        store,
        dispatch: async () => {
          dispatches++;
          throw Error("No replay");
        },
      });
      await runtime.reconcile();
      const retained = await store.inspect(id);
      expect(retained?.status).toMatchObject({
        status: "partial",
        publication: "committed",
        result: { kind: "overture-sync", release: "2026-07-22.0" },
      });
      expect(retained?.triggeredBy).toBe("cron");
      expect(retained?.finishedAt).not.toBeNull();
      expect(
        control.verifyDataControlTerminalWitness(installation, retained!.execution).status,
      ).toEqual(retained!.status);
      expect(dispatches).toBe(1);
    } finally {
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
  it("never compensates an uncertain local transit publication", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    drizzle(sql);
    const root = mkdtempSync(join(tmpdir(), "omx-transit-publication-")),
      data = join(root, "data");
    mkdirSync(data, { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    let forwards = 0;
    const runtime = createDataExecutionRuntime({
      store,
      dispatch: async (_input, context) => {
        const job = buildJobContext({
          dataDir: data,
          store: new StateStore(data),
          jobId: context.execution.executionId,
          countries: ["de"],
          executionContext: context,
          abortSignal: context.signal,
        });
        try {
          await publishDataChange(async () => {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(join(data, "synthetic-live-publication"), "committed prefix");
            throw Error("Synthetic lost local publication response");
          });
        } catch (error) {
          preserveTransitPending(job, error);
          forwards++;
          throw error;
        }
        return {
          kind: "transit-sync",
          finalStatus: "ok",
          sourceRevision: "public-fixture",
          countries: ["de"],
        };
      },
    });
    let id: string | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = await runtime.admit(
          { kind: "transit-sync", countries: ["de"] },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
      id = admitted.id;
      await expect
        .poll(
          async () => {
            const { existsSync } = await import("node:fs");
            return existsSync(
              join(root, "control-private/data-manager/observations", `worker-${key}.json`),
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      expect(forwards).toBe(0);
      expect((await store.inspect(id))?.finishedAt).toBeNull();
      expect((await store.inspect(id))?.status.publication).toBe("unknown");
      expect(
        (await import("node:fs")).existsSync(join(data, ".admin-target-control/locks/motis")),
      ).toBe(true);
    } finally {
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
  it("retires the indexed unbound phase cells with the original completed family after its expiry floor", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    drizzle(sql);
    const root = mkdtempSync(join(tmpdir(), "omx-phase-retirement-")),
      data = join(root, "data");
    mkdirSync(data, { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, {
        controlJournal: journal,
        now: () => Date.now(),
      }),
      runtime = createDataExecutionRuntime({
        store,
        dispatch: async () => ({
          kind: "transit-sync",
          finalStatus: "ok",
          sourceRevision: "public-fixture",
          countries: ["de"],
        }),
      });
    let id: string | undefined, clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = await runtime.admit(
          { kind: "transit-sync", countries: ["de"] },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
      id = admitted.id;
      await expect
        .poll(async () => (await store.inspect(id!))?.status.status, { timeout: 15000 })
        .toBe("ok");
      await expect
        .poll(
          async () =>
            !(await import("node:fs")).existsSync(
              join(data, ".admin-target-control/locks/data-manager"),
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      await runtime.close();
      const record = await store.inspect(id);
      expect(record?.reservations).toHaveLength(8);
      const cells = record!.reservations.map((slot) =>
        join(
          root,
          "control-private/data-manager/observations",
          `phase-${key}-${slot.ordinal}.json`,
        ),
      );
      expect(cells.every((path) => requireExists(path))).toBe(true);
      clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 72 * 3600000 + 1);
      let retired = 0;
      for (let n = 0; n < 64 && retired === 0; n++)
        retired += (await control.reconcileControlRetention(installation, { maxFamilies: 1 }))
          .retired;
      expect(retired).toBe(1);
      expect(await store.inspect(id)).toBeNull();
      expect(cells.every((path) => !requireExists(path))).toBe(true);
      await expect(
        store.admit(
          { kind: "transit-sync", countries: ["de"] },
          { operationKey: key, requestedDeadlineAt: deadline },
        ),
      ).rejects.toThrow(/fresh dated|expired/i);
    } finally {
      clock?.mockRestore();
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("locked production Drizzle and postgres query cancellation", () => {
  it.each([
    "mapped-held",
    "mapped-aborted",
    "values-then",
    "values-catch",
    "values-finally",
    "raw-finally",
  ] as const)(
    "contains the actual mapped/fluent query (%s)",
    async (mode) => {
      const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
      if (!url) throw Error("Owned PostgreSQL required");
      const sql = postgres(url, { max: 8 }),
        workerSql = withDataSqlCancellation(sql);
      const { sql: expression } = await import("drizzle-orm");
      const { pgSchema, integer } = await import("drizzle-orm/pg-core");
      const db = drizzle(workerSql),
        suffix = randomUUID().replaceAll("-", ""),
        tableName = `fix1_query_${suffix}`,
        fn = `fix1_hit_${suffix}`;
      const table = pgSchema("data_manager").table(tableName, {
        id: integer("id"),
        hits: integer("hits"),
      });
      await sql.unsafe(
        `CREATE TABLE data_manager.${tableName}(id int PRIMARY KEY,hits int NOT NULL)`,
      );
      await sql.unsafe(`INSERT INTO data_manager.${tableName} VALUES(1,0)`);
      await sql.unsafe(
        `CREATE FUNCTION data_manager.${fn}() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE data_manager.${tableName} SET hits=hits+1 WHERE id=1; RETURN 1; END $$`,
      );
      const root = mkdtempSync(join(tmpdir(), "omx-fix1-mapped-"));
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await control.provisionControlInstallation(root);
      const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      });
      const journal = control.createDataExecutionControlJournal(installation, sql),
        store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
      let workerReady = () => {},
        letQueryStart = () => {},
        locked = () => {},
        unlock = () => {};
      const ready = new Promise<void>((resolve) => {
          workerReady = resolve;
        }),
        start = new Promise<void>((resolve) => {
          letQueryStart = resolve;
        });
      const lockReady = new Promise<void>((resolve) => {
          locked = resolve;
        }),
        lockHeld = new Promise<void>((resolve) => {
          unlock = resolve;
        });
      const locker =
        mode === "mapped-held"
          ? sql.begin(async (tx) => {
              await tx.unsafe(`LOCK TABLE data_manager.${tableName} IN ACCESS EXCLUSIVE MODE`);
              locked();
              await lockHeld;
            })
          : Promise.resolve();
      if (mode === "mapped-held") await lockReady;
      let querySettled = false,
        queryRejected = false,
        fluentIdentity = true,
        finalized = 0;
      const runtime = createDataExecutionRuntime({
        store,
        dispatch: async (_input, context) => {
          workerReady();
          await start;
          try {
            if (mode.startsWith("mapped")) {
              await db
                .select({ seen: expression<number>`data_manager.${expression.identifier(fn)}()` })
                .from(table);
            } else {
              const query = workerSql.unsafe(`SELECT data_manager.${fn}() AS seen`);
              const fluent = mode === "raw-finally" ? query.raw() : query.values();
              fluentIdentity = Object.is(fluent, query);
              if (mode === "values-catch")
                await fluent.catch((error) => {
                  throw error;
                });
              else if (mode.endsWith("finally"))
                await fluent.finally(() => {
                  finalized++;
                });
              else await fluent.then((value) => value);
            }
          } catch (error) {
            queryRejected = true;
            throw error;
          } finally {
            querySettled = true;
          }
          context.signal.throwIfAborted();
          return { kind: "download-fonts", completed: true };
        },
      });
      let id: string | undefined;
      try {
        const deadline = Date.now() + 60000,
          key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
        const admitted = await runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
        id = admitted.id;
        await ready;
        if (mode === "mapped-held") {
          letQueryStart();
          await expect
            .poll(
              async () =>
                (
                  await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE query LIKE ${"%" + tableName + "%"} AND wait_event_type='Lock'`
                )[0]?.count,
              { timeout: 10000 },
            )
            .toBe(1);
        }
        await runtime.requestCancel({ id, operationKey: key, fingerprint: admitted.fingerprint });
        letQueryStart();
        await expect.poll(() => querySettled, { timeout: 5000 }).toBe(true);
        expect(queryRejected).toBe(true);
        expect(fluentIdentity).toBe(true);
        if (mode.endsWith("finally")) expect(finalized).toBe(1);
        unlock();
        await locker;
        expect((await sql.unsafe(`SELECT hits FROM data_manager.${tableName}`))[0]?.hits).toBe(0);
        await expect
          .poll(async () => (await store.inspect(id!))?.status.status, { timeout: 15000 })
          .toBe("canceled");
      } finally {
        letQueryStart();
        unlock();
        await locker;
        await runtime.close();
        if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
        await sql.unsafe(`DROP FUNCTION data_manager.${fn}()`);
        await sql.unsafe(`DROP TABLE data_manager.${tableName}`);
        journal.close();
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60000,
  );
});
