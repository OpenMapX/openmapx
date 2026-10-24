import { chmodSync, lstatSync, mkdirSync, rmdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tightenCustomIntegrations } from "./custom-integrations-modes";

const LOCK_NAME = ".trusted-config-writer";
const WAIT_MS = 5_000;

export class ConfigurationWriterBusyError extends Error {
  constructor() {
    super("Configuration writer is busy; an interrupted writer requires operator recovery");
  }
}

/**
 * POSIX mkdir provides exclusive ownership across CLI and host processes on the
 * same local filesystem. Never remove an existing lock, including after a crash:
 * time, a PID and a failed liveness check are not authority to steal ownership.
 * Recovery requires stopping ALL writers before an operator removes the lock.
 */
export async function acquireConfigurationOwnership(
  infraDir: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Configuration ownership requires Linux or macOS local POSIX storage");
  }
  const owner = process.geteuid?.();
  let root = lstatSync(infraDir);
  // infra/docker holds the current-generation pointer and this lock, so only
  // its owner may write it. Git creates it with the checkout's umask (group-
  // writable under 002); its owner, the stack-operating user that every
  // writer runs as, takes the group and other write bits away instead of
  // asking the operator to.
  if (root.isDirectory() && !root.isSymbolicLink() && root.uid === owner) {
    if ((root.mode & 0o022) !== 0) {
      chmodSync(infraDir, root.mode & 0o7755);
      root = lstatSync(infraDir);
    }
  }
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== owner ||
    (root.mode & 0o022) !== 0
  ) {
    throw new Error("Unsafe configuration ownership directory");
  }
  const path = join(infraDir, LOCK_NAME);
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new ConfigurationWriterBusyError();
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: Stats;
      try {
        existing = lstatSync(path);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      if (
        !existing.isDirectory() ||
        existing.isSymbolicLink() ||
        existing.uid !== owner ||
        (existing.mode & 0o777) !== 0o700
      ) {
        throw new Error("Unsafe configuration writer ownership");
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConfigurationWriterBusyError();
      await delay(Math.min(25, remaining), undefined, { signal });
    }
  }
  const held = lstatSync(path);
  // Every writer passes here before it reads what it renders, including the
  // installed integrations' schemas, which the agent loads only from files
  // nobody else can write. Their owner removes the group and other write an
  // earlier installer or the umask left, as for infra/docker above.
  tightenCustomIntegrations(join(infraDir, "..", ".."), owner);
  let released = false;
  return () => {
    if (released) throw new Error("Configuration ownership already released");
    const current = lstatSync(path);
    if (
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink()
    ) {
      throw new Error("Configuration writer ownership changed");
    }
    // No recursive deletion: unexpected contents fail closed.
    rmdirSync(path);
    released = true;
  };
}
