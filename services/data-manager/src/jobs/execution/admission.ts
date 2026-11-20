import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import type postgres from "postgres";
import type { DataConfigurationMaintenance } from "./configuration-maintenance.js";

let maintenance: DataConfigurationMaintenance | undefined;
/** Installed once by the assembled service before startup writers or cron. */
export function installDataMutationAdmission(value: DataConfigurationMaintenance): void {
  if (maintenance && maintenance !== value) throw Error("Data admission adapter already installed");
  maintenance = value;
}
export async function assertDataMutationAdmission(tx: postgres.TransactionSql): Promise<void> {
  if (!maintenance)
    throw Object.assign(Error("Data admission prerequisites are unavailable"), { statusCode: 503 });
  // Shared: ordinary writers only need configuration maintenance and execution
  // admission kept out, which both take this lock exclusively. An exclusive
  // lock here turned concurrent writers away from each other as "busy".
  const [namespace, key] = DATA_ADVISORY_LOCKS.dataAdmission;
  const lock = await tx`SELECT pg_try_advisory_xact_lock_shared(${namespace},${key}) AS held`;
  if (lock[0]?.held !== true)
    throw Object.assign(Error("configuration_maintenance_busy"), { statusCode: 409 });
  await maintenance.assertAdmission(tx);
}
