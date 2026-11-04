import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// The Valhalla watchdog holds the writer lock while it clears the live-traffic
// extract at engine start. Its pid belongs to the Valhalla container's PID
// namespace and says nothing about processes here, and on a slow disk the clear
// outlasts the worker threshold. Such a lock is stale only after this long.
const WATCHDOG_LOCK_STALE_MS = 10 * 60_000;

/** Only a supervisor may fence its own worker; never kill a PID read from disk. */
export async function recoverTrafficWriterLock(options: {
  statePath: string;
  now?: number;
  workerPid?: number;
  stopWorker: () => Promise<void>;
}): Promise<void> {
  const lock = `${options.statePath}.lock`;
  let modified: number;
  try {
    modified = (await stat(lock)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let owner: { pid?: number; acquiredAt?: number; owner?: string };
  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch {
    owner = {};
  }
  const acquiredAt =
    typeof owner?.acquiredAt === "number" && Number.isFinite(owner.acquiredAt)
      ? Math.min(owner.acquiredAt, modified)
      : modified;
  if (owner.owner === "valhalla-watchdog") {
    // Judged on the real clock: a forced `now` speaks only for this
    // supervisor's own writer. Traffic maintenance starts Valhalla while its
    // fence is still up, so forcing here would pull the lock out from under
    // the watchdog mid-clear and the engine would never be admitted.
    if (Date.now() - acquiredAt < WATCHDOG_LOCK_STALE_MS) return;
    await rm(lock, { recursive: true, force: true });
    return;
  }
  if ((options.now ?? Date.now()) - acquiredAt < 20_000) return;
  if (owner.pid === options.workerPid && options.workerPid !== undefined) {
    await options.stopWorker(); // Wait for actual exit before another writer can run.
  } else if (owner.pid !== undefined) {
    try {
      process.kill(owner.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        await rm(lock, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    throw new Error("Traffic lock belongs to an unexpected live process");
  } else if (options.workerPid !== undefined) {
    await options.stopWorker();
  }
  await rm(lock, { recursive: true, force: true });
}

// The agent bounds a maintenance job at 30 minutes; a pause past that (with
// slack for stopping and starting Valhalla) means the job is no longer running.
const MAINTENANCE_OVERDUE_MS = 35 * 60_000;
const MAINTENANCE_OVERDUE_REPEAT_MS = 30 * 60_000;

/**
 * Says why the supervisor keeps its worker stopped while the maintenance
 * fence is present: once on pausing, again whenever the pause outlasts any
 * running job, and once on resuming. Without it a fence left behind leaves the
 * service silently down.
 */
export function createMaintenancePauseReporter(options: {
  report: (message: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let paused: { job: string; startedAt: number; startedLabel: string } | undefined;
  let lastOverdueAt: number | undefined;
  return {
    /** Called on every pass while the fence is present; its contents are read once per pause. */
    paused(readFence: () => string | null) {
      if (!paused) {
        let parsed: { operationId?: unknown; plan?: unknown; startedAt?: unknown } = {};
        try {
          parsed = JSON.parse(readFence() ?? "") ?? {};
        } catch {
          // Reported as an unknown job below.
        }
        const job =
          typeof parsed.operationId === "string" && /^[0-9a-f]{64}$/.test(parsed.operationId)
            ? parsed.operationId.slice(0, 16)
            : "unknown";
        const plan =
          typeof parsed.plan === "string" && /^[a-z][a-z-]{0,63}$/.test(parsed.plan)
            ? ` ${parsed.plan}`
            : "";
        const fenceStarted =
          typeof parsed.startedAt === "string" ? Date.parse(parsed.startedAt) : Number.NaN;
        const startedAt = Number.isFinite(fenceStarted) ? fenceStarted : now();
        paused = { job, startedAt, startedLabel: new Date(startedAt).toISOString() };
        lastOverdueAt = undefined;
        options.report(
          `Traffic worker paused for Valhalla maintenance${plan} (job ${job}, started ${paused.startedLabel}); it resumes when the maintenance fence is removed`,
        );
      }
      const current = now();
      if (
        current - paused.startedAt >= MAINTENANCE_OVERDUE_MS &&
        (lastOverdueAt === undefined || current - lastOverdueAt >= MAINTENANCE_OVERDUE_REPEAT_MS)
      ) {
        lastOverdueAt = current;
        options.report(
          `Traffic worker still paused for Valhalla maintenance job ${paused.job}, started ${paused.startedLabel}: longer than any maintenance runs. The operations agent releases an interrupted job when it restarts; a failed one needs an operator: see "Graph maintenance pauses" in the monitoring guide`,
        );
      }
    },
    resumed() {
      if (!paused) return;
      options.report(`Traffic worker resumed after Valhalla maintenance job ${paused.job}`);
      paused = undefined;
    },
  };
}
