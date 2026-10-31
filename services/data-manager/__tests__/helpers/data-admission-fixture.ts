/** Admission prerequisites for the existing disposable DB suites. This runs
 * only in those new owned fixtures, never against the retained Task02.3 DB. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import type postgres from "postgres";
import { installDataMutationAdmission } from "../../src/jobs/execution/admission.js";
import { createDataConfigurationMaintenance } from "../../src/jobs/execution/configuration-maintenance.js";
export async function installDisposableDataAdmission(sql: postgres.Sql): Promise<() => void> {
  const existing = await sql.unsafe("SELECT to_regclass('data_manager.jobs') AS table_name");
  if (existing[0]?.table_name) throw Error("Admission fixture requires its new disposable schema");
  const migrations = resolve(import.meta.dirname, "../../../../apps/api/src/db/migrations");
  for (const name of [
    "0004_data_manager_jobs_and_feed_state.sql",
    "0042_admin_data_execution.sql",
  ]) {
    const body = readFileSync(join(migrations, name), "utf8")
      .replace('CREATE SCHEMA "data_manager";', 'CREATE SCHEMA IF NOT EXISTS "data_manager";')
      .replaceAll("--> statement-breakpoint", "");
    await sql.unsafe(body);
  }
  const root = mkdtempSync(join(tmpdir(), "omx-disposable-admission-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
  const installation = openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager"],
    }),
    fence = createDataConfigurationMaintenance(sql, installation);
  await fence.startup();
  installDataMutationAdmission(fence);
  return () => {
    closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  };
}
