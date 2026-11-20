/** Admission prerequisites for the existing disposable DB suites. This runs
 * only in those new owned fixtures, never against the retained Task02.3 DB. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  closeControlInstallation,
  createDataExecutionControlJournal,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import type postgres from "postgres";
import { installDataMutationAdmission } from "../../src/jobs/execution/admission.js";
import { createDataConfigurationMaintenance } from "../../src/jobs/execution/configuration-maintenance.js";
import { installLocalDataExecutions } from "../../src/jobs/execution/local.js";
import { createDataExecutionReceiver } from "../../src/jobs/execution/receiver.js";
import { createDataExecutionRuntime } from "../../src/jobs/execution/runtime.js";
import { createPostgresDataExecutionStore } from "../../src/jobs/execution/store.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
export async function installDisposableDataAdmission(
  sql: postgres.Sql,
): Promise<() => Promise<void>> {
  const existing = await sql.unsafe("SELECT to_regclass('data_manager.jobs') AS table_name");
  if (existing[0]?.table_name) throw Error("Admission fixture requires its new disposable schema");
  const migrations = resolve(import.meta.dirname, "../../../../apps/api/src/db/migrations");
  for (const name of [
    "0004_data_manager_jobs_and_feed_state.sql",
    "0042_admin_data_execution.sql",
    "0063_configuration_fence_table.sql",
    "0066_update_system_job_rows.sql",
  ]) {
    // Only the data_manager statements: the disposable schema has no API tables.
    const statements = readFileSync(join(migrations, name), "utf8")
      .replace('CREATE SCHEMA "data_manager";', 'CREATE SCHEMA IF NOT EXISTS "data_manager";')
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes('"data_manager"'));
    await sql.unsafe(statements.join("\n"));
  }
  const root = mkdtempSync(join(tmpdir(), "omx-disposable-admission-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  const installation = openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager"],
    }),
    fence = createDataConfigurationMaintenance(sql, installation);
  await fence.startup();
  installDataMutationAdmission(fence);
  // In-process data jobs run through the durable runtime on this database.
  const runtime = createDataExecutionRuntime({
    store: createPostgresDataExecutionStore(sql, {
      controlJournal: createDataExecutionControlJournal(installation, sql),
      configurationFence: fence,
    }),
    dispatch: async () => {
      throw Error("Only in-process work runs in this fixture");
    },
    // Workers share the fixture's pool; cancellation is covered by the runtime suite.
    openSql: () => ({ sql, close: async () => {} }),
  });
  installLocalDataExecutions(
    createDataExecutionReceiver({
      runtime,
      installation,
      configurationFence: fence,
      dispatcher: {} as never,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
    }),
  );
  return async () => {
    await runtime.close();
    closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  };
}
