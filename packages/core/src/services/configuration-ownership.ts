import { lstatSync, mkdirSync, rmdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWrite } from "../release-files";

/** The writer lock, in the agent's state: `state/ops-agent/configuration/.writer`. */
const CONFIGURATION_DIRECTORY = ["state", "ops-agent", "configuration"] as const;
const LOCK_NAME = ".writer";
/** Where releases before this one took it, in `infra/docker` itself. */
const LEGACY_LOCK_NAME = ".trusted-config-writer";
/** Written once no agent of an earlier release can run any more. */
const LEGACY_LOCK_RETIRED = "legacy-configuration-writer-retired.json";
const WAIT_MS = 5_000;

export class ConfigurationWriterBusyError extends Error {
  constructor() {
    super("Configuration writer is busy; an interrupted writer requires operator recovery");
  }
}

function owner(): number {
  return process.geteuid?.() ?? 0;
}

/**
 * One of the agent's own directories: a real directory of this user that
 * nobody else can reach. Refused, never repaired.
 */
function assertOwnDirectory(path: string): void {
  const stats = lstatSync(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== owner() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Unsafe configuration ownership directory: ${path} must be a directory owned by uid ${owner()} that its group and others cannot reach`,
    );
  }
}

function retiredMarker(infraDir: string): string {
  return join(infraDir, "state", "ops-agent", LEGACY_LOCK_RETIRED);
}

/**
 * Whether writers still take the earlier releases' lock in `infra/docker` as
 * well. They do until this release's agent has started with no handoff helper
 * running: until then an agent of an earlier release may still run, or be
 * restored by a helper rolling back, and it knows only that lock.
 */
export function legacyConfigurationWriterActive(infraDir: string): boolean {
  try {
    lstatSync(retiredMarker(infraDir));
    return false;
  } catch {
    return true;
  }
}

/** Stop taking the earlier releases' lock. Call only from this release's agent. */
export function retireLegacyConfigurationWriter(infraDir: string): void {
  if (!legacyConfigurationWriterActive(infraDir)) return;
  atomicWrite(
    retiredMarker(infraDir),
    `${JSON.stringify({ version: 1, retiredAt: new Date().toISOString() })}\n`,
    0o600,
  );
}

async function acquireLockDirectory(path: string, signal?: AbortSignal): Promise<() => void> {
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
        existing.uid !== owner() ||
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

/**
 * POSIX mkdir provides exclusive ownership across CLI and host processes on the
 * same local filesystem. Never remove an existing lock, including after a crash:
 * time, a PID and a failed liveness check are not authority to steal ownership.
 * Recovery requires stopping ALL writers before an operator removes the lock.
 *
 * The lock and everything it guards live in the agent's state directory, which
 * the host CLI shares as the same user; `infra/docker`'s own modes decide
 * nothing. While an agent of an earlier release can still run, its lock in
 * `infra/docker` is taken too, first, so the two never commit at once.
 */
export async function acquireConfigurationOwnership(
  infraDir: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Configuration ownership requires Linux or macOS local POSIX storage");
  }
  const state = join(infraDir, "state", "ops-agent");
  const directory = join(infraDir, ...CONFIGURATION_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnDirectory(state);
  assertOwnDirectory(directory);
  const releaseLegacy = legacyConfigurationWriterActive(infraDir)
    ? await acquireLockDirectory(join(infraDir, LEGACY_LOCK_NAME), signal)
    : null;
  let release: () => void;
  try {
    release = await acquireLockDirectory(join(directory, LOCK_NAME), signal);
  } catch (error) {
    releaseLegacy?.();
    throw error;
  }
  return () => {
    try {
      release();
    } finally {
      releaseLegacy?.();
    }
  };
}
