import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { installationState } from "../../../../../packages/core/src/build-artifacts/private-records";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";

/** A data-manager process over `root` and the shared database: its own installation, journal, store and runtime. */
function dataManagerProcess(
  sql: postgres.Sql,
  root: string,
  dispatch: Parameters<typeof createDataExecutionRuntime>[0]["dispatch"],
) {
  const installation = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager"],
    }),
    journal = control.createDataExecutionControlJournal(installation, sql),
    store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
  return { installation, store, runtime: createDataExecutionRuntime({ store, dispatch }) };
}

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
        await sql`SELECT execution_admission,execution_progress FROM data_manager.jobs WHERE id=${id}`;
      expect(stored?.execution_admission).toMatchObject({
        serviceIds: ["data-manager"],
        plan: [],
        origin: { rootKey: key, issuer: "data-manager", notAfter: deadline },
      });
      expect(stored?.execution_progress).toMatchObject({
        phase: "settled",
        settlement: { outcome: "committed", publication: "committed" },
      });
      // Data-manager writes no row file.
      expect(existsSync(join(root, "state/data-manager/control/executions"))).toBe(false);
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
});
