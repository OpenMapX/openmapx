import { services } from "@openmapx/core/server";
import { dockerCompose } from "./docker";

export interface RollbackPlan {
  currentRevisionId: string;
  targetRevisionId: string;
  current: services.GenerationRelease | null;
  target: services.GenerationRelease | null;
}

/** The applied generation and the one applied before it, with the releases they pin. */
export function planRollback(infraDir: string): RollbackPlan {
  const currentRevisionId = services.currentConfigurationGeneration(infraDir);
  if (!currentRevisionId) throw new Error("No configuration has been applied yet");
  const targetRevisionId = services.readPreviousConfigurationGeneration(
    infraDir,
    currentRevisionId,
  );
  if (!targetRevisionId)
    throw new Error("The applied configuration is the first one; there is nothing to roll back to");
  try {
    services.configurationGenerationComposeFile(infraDir, targetRevisionId);
  } catch (error) {
    throw new Error(`The previous configuration ${targetRevisionId} is no longer retained`, {
      cause: error,
    });
  }
  return {
    currentRevisionId,
    targetRevisionId,
    current: services.readGenerationRelease(infraDir, currentRevisionId),
    target: services.readGenerationRelease(infraDir, targetRevisionId),
  };
}

/**
 * Refuses a rollback whose images could run against a newer database schema:
 * the migrator only applies migrations newer than the newest applied one, so
 * an older API would start against the newer schema without complaint. The
 * newest applied migration must not be newer than the target release's
 * recorded migration head. Rolling back within one release changes no image
 * and needs no check.
 */
export function assertDatabaseAllowsRollback(
  plan: RollbackPlan,
  newestAppliedMigration: number | null,
): void {
  if (plan.current?.manifestDigest === plan.target?.manifestDigest) return;
  if (!plan.target)
    throw new Error(
      "The previous configuration pins no release, so the database migrations its images expect are unknown. Rollback refuses; restore a backup taken before the update instead.",
    );
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
