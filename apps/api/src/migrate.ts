/**
 * Applies the pending database migrations and exits.
 *
 * `openmapx services update` runs this in a one-off app-api container before
 * it replaces app-api, so a long migration is its own step with its own output
 * rather than part of app-api's startup and healthcheck. app-api still applies
 * any pending migrations when it starts; after this step there are none.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { envString } from "@openmapx/core/server-env";
import { openMigrationSession, sql } from "./db/index";
import { type MigrationRun, startMigrations } from "./db/migration-runner";
import { applyRequiredMigrations } from "./startup-migrations";
import { createSafePinoOptions } from "./utils/safe-log-fields";

const { default: pino } = await import("pino");
const log = pino(createSafePinoOptions(envString("LOG_LEVEL", "info")));

// The one-off container runs this as PID 1, which ignores SIGTERM without a
// handler. Stopping the container must stop the migration in Postgres too.
let run: MigrationRun | undefined;
let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  log.warn({ signal }, "Stopping the database migration");
  void (run?.cancel() ?? Promise.resolve())
    .catch((err) => log.warn(err, "Could not stop the running database migration"))
    .finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const migrationsDir = join(import.meta.dirname ?? ".", "db", "migrations");
const startedAt = Date.now();
try {
  let applied: string[] = [];
  await applyRequiredMigrations({
    migrationsDirectory: migrationsDir,
    directoryExists: existsSync,
    migrate: async () => {
      run = startMigrations({
        session: openMigrationSession(),
        control: sql,
        migrationsFolder: migrationsDir,
        log,
      });
      applied = await run.done;
    },
  });
  log.info(
    { migrations: applied, durationMs: Date.now() - startedAt },
    "Database migrations applied",
  );
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  if (stopping) {
    log.warn("Database migration stopped before it finished; it rolled back");
    // The stop handler exits once the migration has rolled back.
    await new Promise<never>(() => {});
  }
  log.fatal(err, "Database migration failed");
  process.exit(1);
}
