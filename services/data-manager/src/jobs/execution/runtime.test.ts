import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, existsSync as requireExists, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, OpsClientError } from "@openmapx/core/ops";
import { sql as expression } from "drizzle-orm";
import { integer, pgSchema } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { DataManagerReadiness } from "../../readiness.js";
import { initializeRequiredSubsystems } from "../../startup.js";
import { StateStore } from "../../state.js";
import { preserveTransitPending } from "../transitous/owned-ops.js";
import { buildJobContext } from "../transitous/pipeline.js";
import { removePrunedDataRows } from "./prune-rows.js";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";
import { cancellableTransaction, openCancellableSql, publishDataChange } from "./worker-scope.js";

/** Opens each worker's handle as production does: a pool of its own on `url`. */
function workerHandles(url: string, control: postgres.Sql) {
  return (signal: AbortSignal) =>
    openCancellableSql(
      (applicationName) =>
        postgres(url, { max: 4, connection: { application_name: applicationName } }),
      control,
      signal,
    );
}

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
      await control.provisionControlDirectories(root);
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
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("repeats a lease acquisition whose reply was lost and releases the lease it recorded", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    const root = mkdtempSync(join(tmpdir(), "omx-runtime-lost-reply-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const agent = control.agentStoreLeases(root, "ops-agent");
    // Four lost replies span about four seconds, as an agent restart would.
    let lostReplies = 4;
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
        leases: {
          ...agent,
          // The agent records the lease, and its reply never arrives.
          async acquire(input) {
            const lease = await agent.acquire(input);
            if (lostReplies-- > 0)
              throw new OpsClientError(lostReplies % 2 ? "runtime" : "timeout");
            return lease;
          },
        },
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    let effects = 0;
    const runtime = createDataExecutionRuntime({
      store,
      dispatch: async () => {
        effects++;
        return { kind: "download-fonts", completed: true };
      },
    });
    let id: string | undefined;
    try {
      const deadline = Date.now() + 60000;
      const key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      id = (
        await runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        )
      ).id;
      await expect
        .poll(async () => (await runtime.inspect(id!))?.status, { timeout: 15000 })
        .toBe("ok");
      expect(effects).toBe(1);
      expect(lostReplies).toBe(-1);
      await expect
        .poll(
          async () =>
            control
              .openLeaseStore({
                directory: control.leaseStoreDirectory(root),
                purpose: "test",
              })
              .list(),
          { timeout: 15000 },
        )
        .toEqual([]);
    } finally {
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("repairs a worker-completion/publication crash from the original signed completion without redispatch", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-data-completion-gap-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
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
      expect(heldTargets(root).includes("data-manager")).toBe(false);
      await runtime.reconcile();
      expect(dispatches).toBe(1);
    } finally {
      await runtime.close();
      if (!id && key) id = (await store.lookup(key))?.status.id;
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
  it.each(["before-commit", "during-commit"] as const)(
    "cancels a worker transaction through its handle (%s)",
    async (mode) => {
      const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
      if (!url) throw Error("Owned PostgreSQL required");
      const sql = postgres(url, { max: 5 }),
        root = mkdtempSync(join(tmpdir(), "omx-data-transaction-"));
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await control.provisionControlDirectories(root);
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
        openSql: workerHandles(url, sql),
        dispatch: async (_input, context) => {
          await publishDataChange(() =>
            cancellableTransaction(context.sql, async (tx) => {
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
                return (
                  String(rows[0]?.query).toUpperCase() === "COMMIT" &&
                  rows[0]?.wait_event_type === "Lock"
                );
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
          // The cancelled COMMIT no longer runs: its connection is idle, or the
          // ended worker pool has closed it.
          await expect
            .poll(
              async () => {
                const rows = await sql`SELECT state FROM pg_stat_activity WHERE pid=${workerPid}`;
                return rows[0]?.state ?? "closed";
              },
              { timeout: 15000 },
            )
            .toMatch(/^(idle|closed)$/);
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
    await control.provisionControlDirectories(root);
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
      expect(dispatches).toBe(1);
    } finally {
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
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
    await control.provisionControlDirectories(root);
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
              join(root, "state/data-manager/control/observations", `worker-${key}.json`),
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      expect(forwards).toBe(0);
      expect((await store.inspect(id))?.finishedAt).toBeNull();
      expect((await store.inspect(id))?.status.publication).toBe("unknown");
      expect(heldTargets(dirname(data)).includes("motis")).toBe(true);
    } finally {
      await runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
  it.each(["startup", "periodic"] as const)(
    "prunes a finished execution's records and row through the production %s prune",
    async (phase) => {
      const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
      if (!url) throw Error("Owned PostgreSQL required");
      const sql = postgres(url, { max: 4 });
      drizzle(sql);
      const root = mkdtempSync(join(tmpdir(), "omx-data-prune-")),
        data = join(root, "data");
      mkdirSync(data, { mode: 0o700 });
      await control.provisionControlDirectories(root);
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
      let stopRetention: (() => Promise<void>) | undefined;
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
          .poll(async () => !heldTargets(dirname(data)).includes("data-manager"), {
            timeout: 15000,
          })
          .toBe(true);
        await runtime.close();
        const record = await store.inspect(id);
        expect(record?.reservations).toHaveLength(8);
        const cells = record!.reservations.map((slot) =>
          join(
            root,
            "state/data-manager/control/observations",
            `phase-${key}-${slot.ordinal}.json`,
          ),
        );
        expect(cells.every((path) => requireExists(path))).toBe(true);
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        if (phase === "startup")
          clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 72 * 3600000 + 1);
        const startup = await initializeRequiredSubsystems({
          readiness: new DataManagerReadiness(),
          controlInstallation: installation,
          initializeOfflineStorage: async () => {},
          reconcileJobs: async () => {},
          setupCronSchedulers: () => ({ stop() {} }) as never,
          removePrunedRows: (keys) => removePrunedDataRows(sql, keys),
        });
        stopRetention = startup.stopControlPrune;
        if (phase === "periodic") {
          expect(await store.inspect(id)).not.toBeNull();
          clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 72 * 3600000 + 1);
          // The prune runs hourly after its startup pass.
          await vi.advanceTimersByTimeAsync(3600_000);
          await stopRetention?.();
        }
        expect(await store.inspect(id)).toBeNull();
        expect(cells.every((path) => !requireExists(path))).toBe(true);
        await expect(
          store.admit(
            { kind: "transit-sync", countries: ["de"] },
            { operationKey: key, requestedDeadlineAt: deadline },
          ),
        ).rejects.toThrow(/fresh dated|expired/i);
      } finally {
        await stopRetention?.();
        vi.useRealTimers();
        clock?.mockRestore();
        await runtime.close();
        if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60000,
  );
});

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("worker database handle cancellation", () => {
  async function workerFixture(prefix: string) {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql);
    return {
      sql,
      store: createPostgresDataExecutionStore(sql, { controlJournal: journal }),
      openSql: workerHandles(url, sql),
      async close() {
        control.closeControlInstallation(installation);
        await sql.end();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }
  async function admitFonts(runtime: ReturnType<typeof createDataExecutionRuntime>) {
    const deadline = Date.now() + 60000,
      operationKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
    const admitted = await runtime.admit(
      { kind: "download-fonts" },
      { operationKey, requestedDeadlineAt: deadline },
    );
    return { id: admitted.id, operationKey, fingerprint: admitted.fingerprint };
  }
  /** The PostgreSQL or driver code a query failed with; Drizzle keeps it on the cause. */
  const outcome = (query: PromiseLike<unknown>) =>
    Promise.resolve(query).then(
      () => "completed",
      (error: { code?: string; cause?: { code?: string } }) =>
        error.code ?? error.cause?.code ?? "rejected",
    );

  it("cancels a running statement through the worker's handle and refuses later queries", async () => {
    const fixture = await workerFixture("omx-worker-sql-");
    const marker = `omx_sleep_${randomUUID().replaceAll("-", "")}`;
    let statement: string | undefined, later: string | undefined;
    const runtime = createDataExecutionRuntime({
      store: fixture.store,
      openSql: fixture.openSql,
      dispatch: async (_input, context) => {
        statement = await outcome(context.sql.unsafe(`SELECT pg_sleep(30), '${marker}'`));
        later = await outcome(context.sql`SELECT 1`);
        context.signal.throwIfAborted();
        return { kind: "download-fonts", completed: true };
      },
    });
    const sleeping = async () =>
      Number(
        (
          await fixture.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE query LIKE ${`%${marker}%`} AND state='active' AND pid<>pg_backend_pid()`
        )[0]?.count,
      );
    let id: string | undefined;
    try {
      const identity = await admitFonts(runtime);
      id = identity.id;
      await expect.poll(sleeping, { timeout: 10000 }).toBe(1);
      const cancelledAt = Date.now();
      await runtime.requestCancel(identity);
      await expect
        .poll(async () => (await fixture.store.inspect(identity.id))?.status.status, {
          timeout: 15000,
        })
        .toBe("canceled");
      expect(Date.now() - cancelledAt).toBeLessThan(15000);
      expect(statement).toBe("57014");
      expect(later).toBe("CONNECTION_ENDED");
      expect(await sleeping()).toBe(0);
      expect((await fixture.store.inspect(identity.id))?.status.publication).toBe("not_started");
    } finally {
      await runtime.close();
      if (id) await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      await fixture.close();
    }
  }, 60000);
  it("cancels a Drizzle query on the worker's handle while it waits for a lock", async () => {
    const fixture = await workerFixture("omx-worker-drizzle-");
    const suffix = randomUUID().replaceAll("-", ""),
      tableName = `worker_query_${suffix}`,
      fn = `worker_hit_${suffix}`;
    const table = pgSchema("data_manager").table(tableName, {
      id: integer("id"),
      hits: integer("hits"),
    });
    await fixture.sql.unsafe(
      `CREATE TABLE data_manager.${tableName}(id int PRIMARY KEY,hits int NOT NULL)`,
    );
    await fixture.sql.unsafe(`INSERT INTO data_manager.${tableName} VALUES(1,0)`);
    await fixture.sql.unsafe(
      `CREATE FUNCTION data_manager.${fn}() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE data_manager.${tableName} SET hits=hits+1 WHERE id=1; RETURN 1; END $$`,
    );
    let locked = () => {},
      unlock = () => {};
    const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      lockHeld = new Promise<void>((resolve) => {
        unlock = resolve;
      });
    const locker = fixture.sql.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE data_manager.${tableName} IN ACCESS EXCLUSIVE MODE`);
      locked();
      await lockHeld;
    });
    await lockReady;
    let query: string | undefined;
    const runtime = createDataExecutionRuntime({
      store: fixture.store,
      openSql: fixture.openSql,
      dispatch: async (_input, context) => {
        query = await outcome(
          drizzle(context.sql)
            .select({ seen: expression<number>`data_manager.${expression.identifier(fn)}()` })
            .from(table),
        );
        context.signal.throwIfAborted();
        return { kind: "download-fonts", completed: true };
      },
    });
    let id: string | undefined;
    try {
      const identity = await admitFonts(runtime);
      id = identity.id;
      await expect
        .poll(
          async () =>
            (
              await fixture.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE query LIKE ${`%${tableName}%`} AND wait_event_type='Lock'`
            )[0]?.count,
          { timeout: 10000 },
        )
        .toBe(1);
      await runtime.requestCancel(identity);
      await expect.poll(() => query, { timeout: 5000 }).toBe("57014");
      unlock();
      await locker;
      await expect
        .poll(async () => (await fixture.store.inspect(identity.id))?.status.status, {
          timeout: 15000,
        })
        .toBe("canceled");
      expect(
        (await fixture.sql.unsafe(`SELECT hits FROM data_manager.${tableName}`))[0]?.hits,
      ).toBe(0);
    } finally {
      unlock();
      await locker;
      await runtime.close();
      if (id) await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      await fixture.sql.unsafe(`DROP FUNCTION data_manager.${fn}()`);
      await fixture.sql.unsafe(`DROP TABLE data_manager.${tableName}`);
      await fixture.close();
    }
  }, 60000);
});
