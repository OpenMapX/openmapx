import { createFatalProcessHandler } from "@openmapx/core/server";
import { createApp } from "./app";
import { extensionSql, integrationSql, sql } from "./db/index";
import type { MigrationRun } from "./db/migration-runner";
import { cancelRunningExtensionMigrations } from "./extension-migrations";
import { createFatalHandler, createStartupStopHandler } from "./process-lifecycle";
import { processLogger } from "./process-logger";
import { redis } from "./redis";
import { cancelStartupMigrations } from "./server-wiring";

const logger = processLogger;

// No exception shape proves a process is safe to keep serving after control
// reaches a fatal channel. The pinned standalone Undici contains the historical
// parser fix, and structural route tests cover the former double-send cause.
// Terminate uniformly and let the container restart through mandatory startup
// migration/reconciliation rather than continuing with unknown shared state.
const exitFatally = createFatalProcessHandler({
  fatal: (fields, message) => logger.fatal(fields, message),
  exit: (code) => process.exit(code),
});
// The next start counts the exit, against the installed integration whose
// work failed when that is known.
const onFatal = createFatalHandler(exitFatally);
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

// Until the graceful handlers below are installed, a stop request ends startup.
// In the image tini is PID 1 and forwards SIGTERM to Node, which without a
// handler would end at once, and a killed migration's statement would keep
// running in Postgres.
let migrationRun: MigrationRun | undefined;
const startupStop = createStartupStopHandler({
  cancel: () => cancelStartupMigrations(migrationRun, cancelRunningExtensionMigrations, logger),
  exit: (code) => process.exit(code),
  log: logger,
});
const stopDuringStartup = startupStop.onSignal;
process.on("SIGTERM", stopDuringStartup);
process.on("SIGINT", stopDuringStartup);

const app = await createApp({
  logger,
  startup: {
    migrationStarted: (run) => {
      migrationRun = run;
    },
    stopRequested: startupStop.requested,
  },
});
await app.start();

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.off(signal, stopDuringStartup);
  process.on(signal, async () => {
    await app.stop();
    await redis?.disconnect();
    await Promise.all([sql.end(), integrationSql.end(), extensionSql.end()]);
    process.exit(0);
  });
}
