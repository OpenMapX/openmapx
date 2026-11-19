import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { installationState } from "../../../../../packages/core/src/build-artifacts/private-records";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore, dataControlAdmission } from "./store.js";

/** A data-manager process over `root` and the shared database: its own installation, journal, store and runtime. */
function dataManagerProcess(
  sql: postgres.Sql,
  root: string,
  dispatch: Parameters<typeof createDataExecutionRuntime>[0]["dispatch"],
  serviceIds = ["data-manager"],
) {
  const installation = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds,
    }),
    journal = control.createDataExecutionControlJournal(installation, sql),
    store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
  return { installation, journal, store, runtime: createDataExecutionRuntime({ store, dispatch }) };
}
/** Files data-manager left in its private observation directory. */
function observationFiles(root: string): string[] {
  const directory = join(root, "state/data-manager/control/observations");
  return existsSync(directory) ? readdirSync(directory) : [];
}
const HOUR = 3600_000;

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("data-manager execution rows on the job table", () => {
  it("keeps the row on the job row, records the effect start before the work and refuses another admission", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-rows-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    let observed: unknown;
    const dm = dataManagerProcess(sql, root, async (_input, context) => {
      // The row says the effect started before the dispatcher runs.
      const [row] =
        await sql`SELECT execution_progress FROM data_manager.jobs WHERE id=${context.execution.executionId}`;
      observed = row?.execution_progress;
      return { kind: "download-fonts", completed: true };
    });
    let id: string | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = await dm.runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
      id = admitted.id;
      await dm.runtime.settled(id);
      expect(observed).toMatchObject({ phase: "held", effectStartedAt: expect.any(Number) });
      const [stored] =
        await sql`SELECT execution_admission,execution_progress,execution_completion,finished_at FROM data_manager.jobs WHERE id=${id}`;
      expect(stored?.execution_admission).toMatchObject({
        serviceIds: ["data-manager"],
        plan: [],
        origin: { rootKey: key, issuer: "data-manager", notAfter: deadline },
      });
      // The settlement records the terminal the job row committed, at its finish time.
      expect(stored?.execution_progress).toMatchObject({
        phase: "settled",
        settlement: {
          outcome: "committed",
          publication: "committed",
          receipt: {
            kind: "data-execution",
            status: { status: "ok", publication: "committed" },
            terminalAt: (stored?.finished_at as Date).getTime(),
          },
        },
      });
      expect(stored?.execution_completion).toMatchObject({
        outcome: "returned",
        publication: "committed",
        result: { kind: "download-fonts", completed: true },
      });
      // Data-manager writes no row file and no observation file.
      expect(existsSync(join(root, "state/data-manager/control/executions"))).toBe(false);
      expect(observationFiles(root)).toEqual([]);
      const rows = installationState(dm.installation).rows,
        row = await rows.read(key);
      if (!row) throw Error("Execution row missing");
      expect(row.admission.execution).toEqual((await dm.store.inspect(id))?.execution);
      await expect(
        rows.admit({ ...row, admission: { ...row.admission, serviceIds: ["motis"] } }),
      ).rejects.toThrow(/Conflicting/);
      await expect(rows.admit(row)).resolves.toBe("retained");
    } finally {
      await dm.runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(dm.installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("reads the row back after a restart and never dispatches an attempted execution again", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-rows-restart-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    // The first process's worker is still running when the next process starts.
    const first = dataManagerProcess(sql, root, async (_input, context) => {
      started();
      await new Promise((resolve) =>
        context.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("Interrupted");
    });
    let dispatches = 0;
    const next = dataManagerProcess(sql, root, async () => {
      dispatches++;
      return { kind: "download-fonts", completed: true };
    });
    let id: string | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = await first.runtime.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
      id = admitted.id;
      await running;
      const execution = (await first.store.inspect(id))?.execution;
      if (!execution) throw Error("Execution missing");
      // The next process finds the attempted row on the job table.
      const restored = await control.restoreAdmittedControlExecution(next.installation, execution);
      expect(await control.executionEffectStarted(restored)).toBe(true);
      await next.runtime.reconcile();
      expect(dispatches).toBe(0);
      const recovered = await next.store.inspect(id);
      expect(recovered?.status).toMatchObject({ status: "interrupted", publication: "unknown" });
      expect(recovered?.finishedAt).toBeNull();
      // Its outcome is unknown, so its targets stay held.
      expect(heldTargets(dirname(join(root, "data"))).includes("data-manager")).toBe(true);
      const [stored] = await sql`SELECT execution_progress FROM data_manager.jobs WHERE id=${id}`;
      expect(stored?.execution_progress).toMatchObject({
        phase: "cancel_pending",
        settlement: null,
      });
    } finally {
      await first.runtime.close();
      await next.runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(first.installation);
      control.closeControlInstallation(next.installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("inserts the execution row with its job row, and the table refuses an open job row without one", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-rows-insert-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const unused = async () => ({ kind: "download-fonts" as const, completed: true });
    const dm = dataManagerProcess(sql, root, unused),
      // An installation that may not lease data-manager cannot compose the row.
      foreign = dataManagerProcess(sql, root, unused, ["motis"]);
    const created: string[] = [];
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      const refusedKey = createControlRootOperationKey({
        notAfter: deadline,
        nonce: randomBytes(16),
      });
      await expect(
        foreign.store.admit(
          { kind: "download-fonts" },
          { operationKey: refusedKey, requestedDeadlineAt: deadline },
        ),
      ).rejects.toThrow(/Unregistered/);
      expect(await sql`SELECT id FROM data_manager.jobs WHERE operation_key=${refusedKey}`).toEqual(
        [],
      );
      // The store alone, before any worker starts: the row is already there.
      const { record } = await dm.store.admit(
        { kind: "download-fonts" },
        { operationKey: key, requestedDeadlineAt: deadline },
      );
      created.push(record.status.id);
      const [stored] =
        await sql`SELECT execution_admission,execution_progress FROM data_manager.jobs WHERE id=${record.status.id}`;
      expect(stored?.execution_admission).toMatchObject({ serviceIds: ["data-manager"] });
      expect(stored?.execution_progress).toMatchObject({
        phase: "held",
        effectStartedAt: null,
        settlement: null,
      });
      const rowless = randomUUID();
      await expect(
        sql`INSERT INTO data_manager.jobs(id,kind,status,execution_version,operation_key,operation_fingerprint,execution_fingerprint,admitted_at,deadline_at,execution_input,execution_state)
          VALUES(${rowless},'download-fonts','queued',2,${createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) })},${"a".repeat(64)},${"b".repeat(64)},1,${deadline},'{}','{}')`,
      ).rejects.toThrow(/data_manager_jobs_execution_row/);
    } finally {
      await dm.runtime.close();
      await foreign.runtime.close();
      if (created.length) await sql`DELETE FROM data_manager.jobs WHERE id=ANY(${created}::uuid[])`;
      control.closeControlInstallation(dm.installation);
      control.closeControlInstallation(foreign.installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("commits a repeated terminal at its first time and refuses another terminal", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-rows-terminal-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const dm = dataManagerProcess(sql, root, async () => ({
      kind: "download-fonts",
      completed: true,
    }));
    let id: string | undefined;
    try {
      const deadline = Date.now() + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        { record } = await dm.store.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        );
      id = record.status.id;
      const authority = await control.retainAdmittedControlExecution(
        dm.installation,
        dataControlAdmission({
          execution: record.execution,
          input: record.input,
          admittedAt: record.status.admittedAt,
          requestedDeadlineAt: record.requestedDeadlineAt,
          parent: undefined,
          reservations: record.reservations,
        }),
      );
      await dm.journal.begin(authority);
      const result = { kind: "download-fonts" as const, completed: true },
        { completion } = await dm.journal.contain(authority, Promise.resolve(result));
      const terminal = {
          ...record.status,
          status: "ok" as const,
          publication: "committed" as const,
          progress: 1,
          result,
        },
        first = Date.now();
      // A crash after the settlement and before the job row commits repeats it.
      expect(await dm.journal.prepareTerminal(completion, terminal, first)).toBe(first);
      expect(await dm.journal.prepareTerminal(completion, terminal, first + 5000)).toBe(first);
      await expect(
        dm.journal.prepareTerminal(completion, { ...terminal, progress: 0.5 }, first),
      ).rejects.toThrow(/immutable/);
      // Until the job row commits that terminal, it is not proved.
      await expect(dm.journal.verifyContainedTerminal(record.execution)).rejects.toThrow(
        /not proved/,
      );
      const saved = await dm.store.finalize(
        id,
        record.version,
        { status: "ok", publication: "committed", progress: 1, result },
        completion,
      );
      expect(saved?.finishedAt).toBe(first);
      await dm.journal.verifyContainedTerminal(record.execution);
      expect(observationFiles(root)).toEqual([]);
    } finally {
      await dm.runtime.close();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      control.closeControlInstallation(dm.installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("prunes a job row a restore left without its execution row once it finished 72 hours ago and its key expired", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-rows-restored-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const dm = dataManagerProcess(sql, root, async () => ({
      kind: "download-fonts",
      completed: true,
    }));
    const now = Date.now(),
      closed = (admittedAgo: number, finishedAgo: number) => ({
        id: randomUUID(),
        key: createControlRootOperationKey({
          notAfter: now - admittedAgo + HOUR,
          nonce: randomBytes(16),
        }),
        admittedAt: now - admittedAgo,
        finishedAt: new Date(now - finishedAgo).toISOString(),
      });
    const rows = {
      expired: closed(11 * 24 * HOUR, 4 * 24 * HOUR),
      // Finished long ago, but its key could still be valid.
      keyLive: closed(5 * 24 * HOUR, 4 * 24 * HOUR),
      recent: closed(11 * 24 * HOUR, HOUR),
    };
    try {
      for (const row of Object.values(rows))
        await sql`INSERT INTO data_manager.jobs(id,kind,status,finished_at,execution_version,operation_key,operation_fingerprint,execution_fingerprint,admitted_at,deadline_at,execution_input,execution_state)
          VALUES(${row.id},'download-fonts','error',${row.finishedAt}::text::timestamptz,2,${row.key},${"a".repeat(64)},${"b".repeat(64)},${row.admittedAt},${row.admittedAt + HOUR},'{}','{}')`;
      await control.pruneControlRecords(dm.installation, { now });
      const left = (
        await sql`SELECT id FROM data_manager.jobs WHERE id=ANY(${Object.values(rows).map((row) => row.id)}::uuid[])`
      )
        .map((row) => row.id)
        .sort();
      expect(left).toEqual([rows.keyLive.id, rows.recent.id].sort());
    } finally {
      await dm.runtime.close();
      await sql`DELETE FROM data_manager.jobs WHERE id=ANY(${Object.values(rows).map((row) => row.id)}::uuid[])`;
      control.closeControlInstallation(dm.installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
