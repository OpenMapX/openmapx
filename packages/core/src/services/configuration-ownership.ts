import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireRecoverableLock, LockBusyError } from "./recoverable-lock";

/** The writer lock, in the agent's state: `state/ops-agent/configuration/writer.lock`. */
const CONFIGURATION_DIRECTORY = ["state", "ops-agent", "configuration"] as const;
const LOCK_NAME = "writer.lock";

export class ConfigurationWriterBusyError extends Error {
  constructor(cause?: LockBusyError) {
    super(
      `Configuration writer is busy: another configuration change is running. Try again when it finishes.${cause?.holder ? ` ${cause.message}` : ""}`,
    );
  }
}

function owner(): number {
  return process.geteuid?.() ?? 0;
}

/**
 * One of the agent's own directories: a real directory of this user that
 * nobody else can reach. Refused, never repaired.
 */
export function assertOwnDirectory(path: string): void {
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

/**
 * Exclusive configuration writer for the agent, its helper and the host CLI.
 * The lock file records its holder, and another writer reclaims it only when
 * that holder is provably gone; it is never held across a Docker effect.
 * The lock and everything it guards live in the agent's state directory,
 * which the host CLI shares as the same user.
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
  try {
    return await acquireRecoverableLock(join(directory, LOCK_NAME), {
      purpose: "configuration writer",
      signal,
    });
  } catch (error) {
    if (error instanceof LockBusyError) throw new ConfigurationWriterBusyError(error);
    throw error;
  }
}

/** The writer lock's path, for the operator exit. */
export function configurationWriterLockPath(infraDir: string): string {
  return join(infraDir, ...CONFIGURATION_DIRECTORY, LOCK_NAME);
}
