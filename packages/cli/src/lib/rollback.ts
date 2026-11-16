import { services } from "@openmapx/core/server";
import { dockerCompose } from "./docker";

export interface RollbackPlan {
  currentRevisionId: string;
  targetRevisionId: string;
  current: services.GenerationRelease;
  target: services.GenerationRelease;
}

/**
 * The applied generation and the newest retained one that pins another
 * release: the configuration that was applied with the previous release.
 */
export function planRollback(infraDir: string): RollbackPlan {
  const currentRevisionId = services.currentConfigurationGeneration(infraDir);
  if (!currentRevisionId) throw new Error("No configuration has been applied yet");
  const current = services.readGenerationRelease(infraDir, currentRevisionId);
  if (!current)
    throw new Error(
      "The applied configuration pins no release, and rollback compares releases. Pin one with `openmapx compose release` first.",
    );
  const targetRevisionId = services.readPreviousReleaseGeneration(infraDir, currentRevisionId);
  const target = targetRevisionId && services.readGenerationRelease(infraDir, targetRevisionId);
  if (!targetRevisionId || !target)
    throw new Error(
      `No retained configuration pins another release than the applied one (${current.manifest.release}). Rollback returns to the configuration applied with the previous release, and none is retained: no release update was applied, or its configuration was pruned.`,
    );
  return { currentRevisionId, targetRevisionId, current, target };
}

/**
 * Refuses a rollback whose images could run against a newer database schema:
 * the migrator only applies migrations newer than the newest applied one, so
 * an older API would start against the newer schema without complaint. The
 * newest applied migration must not be newer than the target release's
 * recorded migration head.
 */
export function assertDatabaseAllowsRollback(
  plan: RollbackPlan,
  newestAppliedMigration: number | null,
): void {
  const head = plan.target.manifest.databaseMigrationHead;
  if (!head)
    throw new Error(
      `Release ${plan.target.manifest.release} records no database migration head, so rollback cannot prove its images match the database. Restore a backup taken before the update instead.`,
    );
  if (newestAppliedMigration !== null && newestAppliedMigration > head.when)
    throw new Error(
      `The database has migrations newer than release ${plan.target.manifest.release} (its newest is ${head.tag}). Its images would run against a newer schema. Restore a backup taken before the update, or fix forward.`,
    );
}

/** `created_at` of the newest migration the database recorded, or null when it has none. */
export async function readNewestAppliedMigration(): Promise<number | null> {
  const result = await dockerCompose([
    "exec",
    "-T",
    "postgis",
    "psql",
    "-U",
    "postgres",
    "-d",
    "openmapx",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-c",
    "SELECT coalesce(max(created_at), 0) FROM drizzle.__drizzle_migrations",
  ]);
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || !/^\d+$/.test(value))
    throw new Error(
      `The database's migrations could not be read (exit ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-1)[0]}` : ""}); postgis must be running`,
    );
  const newest = Number(value);
  return newest === 0 ? null : newest;
}
