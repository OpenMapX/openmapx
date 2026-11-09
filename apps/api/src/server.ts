import { createFatalProcessHandler } from "@openmapx/core/server";
import { createApiLogger, createApp } from "./app";
import { sql } from "./db/index";
import type { MigrationRun } from "./db/migration-runner";
import { redis } from "./redis";

const logger = await createApiLogger();

// No exception shape proves a process is safe to keep serving after control
// reaches a fatal channel. The pinned standalone Undici contains the historical
// parser fix, and structural route tests cover the former double-send cause.
// Terminate uniformly and let the container restart through mandatory startup
// migration/reconciliation rather than continuing with unknown shared state.
const onFatal = createFatalProcessHandler({
  fatal: (fields, message) => logger.fatal(fields, message),
  exit: (code) => process.exit(code),
});
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

// Until the graceful handlers below are installed, a stop request ends startup.
// As PID 1 without a handler, Node would ignore SIGTERM until Docker kills it,
// and a killed migration's statement would keep running in Postgres.
let migrationRun: MigrationRun | undefined;
let stoppingDuringStartup = false;
const stopDuringStartup = (signal: NodeJS.Signals) => {
  if (stoppingDuringStartup) return;
  stoppingDuringStartup = true;
  logger.warn({ signal }, "Stopping before startup finished");
  void (migrationRun?.cancel() ?? Promise.resolve())
    .catch((err) => logger.warn(err, "Could not stop the running database migration"))
    .finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
};
process.on("SIGTERM", stopDuringStartup);
process.on("SIGINT", stopDuringStartup);

const app = await createApp({
  logger,
  startup: {
    migrationStarted: (run) => {
      migrationRun = run;
    },
    stopRequested: () => stoppingDuringStartup,
  },
});
await app.start();

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.off(signal, stopDuringStartup);
  process.on(signal, async () => {
    await app.stop();
    await redis?.disconnect();
    await sql.end();
    process.exit(0);
  });
}
