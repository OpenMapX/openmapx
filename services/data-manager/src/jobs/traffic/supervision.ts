import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

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
  let owner: { pid?: number; acquiredAt?: number };
  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch {
    owner = {};
  }
  const acquiredAt =
    typeof owner?.acquiredAt === "number" && Number.isFinite(owner.acquiredAt)
      ? Math.min(owner.acquiredAt, modified)
      : modified;
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
