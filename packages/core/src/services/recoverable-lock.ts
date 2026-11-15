import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { fsyncDirectory } from "../release-files";

/**
 * A lock file that records who holds it, so that a holder that died can be told
 * apart from one that is still working. It is held only around short file
 * updates, never across a Docker effect.
 *
 * Holders run in different PID namespaces: the agent and its fixed CLI in the
 * agent's container, the configuration helper in its own container and the
 * host CLI on the host. A lock is reclaimed only when its holder is provably
 * gone: the machine booted since, or the holder shares this PID namespace and
 * its process has ended, or the container it ran in is no longer running.
 * Anything else is refused with the holder named, for `openmapx control clear`.
 */
const holderSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.string().min(1).max(128),
  pid: z.number().int().positive().safe(),
  startTime: z.string().max(32).nullable(),
  bootId: z.string().max(64).nullable(),
  pidNamespace: z.string().max(128).nullable(),
  containerId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  acquiredAt: z.number().int().nonnegative().safe(),
});
export type LockHolder = z.infer<typeof holderSchema>;

export class LockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockHolder | undefined,
  ) {
    super(
      holder
        ? `${basename(path)} is held by ${holder.purpose} (pid ${holder.pid}${holder.containerId ? ` in container ${holder.containerId.slice(0, 12)}` : ""}, since ${new Date(holder.acquiredAt).toISOString()}). If that process is gone, run \`openmapx control status\` and \`openmapx control clear --lock ${basename(path)}\`.`
        : `${basename(path)} is busy`,
    );
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat, after the parenthesised command name. */
function processStartTime(pid: number | "self"): string | null {
  const stat = readOptional(`/proc/${pid}/stat`);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? null;
}

function currentContainerId(): string | null {
  const mounts = readOptional("/proc/self/mountinfo");
  return mounts?.match(/\/containers\/([a-f0-9]{64})\//)?.[1] ?? null;
}

function currentPidNamespace(): string | null {
  if (process.platform !== "linux") return `${process.platform}:${hostname()}`;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

export function currentLockHolder(purpose: string, now = Date.now()): LockHolder {
  return {
    version: 1,
    purpose,
    pid: process.pid,
    startTime: processStartTime("self"),
    bootId: readOptional("/proc/sys/kernel/random/boot_id"),
    pidNamespace: currentPidNamespace(),
    containerId: currentContainerId(),
    acquiredAt: now,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ContainerRunning = (containerId: string) => Promise<boolean | undefined>;

/** Docker's view of a container, or undefined when Docker cannot answer. */
export const dockerContainerRunning: ContainerRunning = (containerId) =>
  new Promise((resolve) => {
    execFile(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerId],
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim() === "true");
        resolve(/no such (object|container)/i.test(stderr) ? false : undefined);
      },
    );
  });

/** Whether `holder` is provably gone, judged from `self`'s place. */
export async function lockHolderGone(
  holder: LockHolder,
  self: LockHolder,
  containerRunning: ContainerRunning = dockerContainerRunning,
): Promise<boolean> {
  if (holder.bootId && self.bootId && holder.bootId !== self.bootId) return true;
  if (holder.pidNamespace && holder.pidNamespace === self.pidNamespace) {
    if (!processAlive(holder.pid)) return true;
    const startTime = processStartTime(holder.pid);
    return Boolean(holder.startTime && startTime && holder.startTime !== startTime);
  }
  if (holder.containerId && holder.containerId !== self.containerId)
    return (await containerRunning(holder.containerId)) === false;
  return false;
}

function readHolderFile(path: string): { holder?: LockHolder; ino: number } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return { ino: stat.ino };
    const buffer = Buffer.alloc(stat.size);
    readSync(descriptor, buffer, 0, buffer.length, 0);
    try {
      return { holder: holderSchema.parse(JSON.parse(buffer.toString("utf8"))), ino: stat.ino };
    } catch {
      // A holder that died between creating and writing its file left it empty.
      return { ino: stat.ino };
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readLockHolder(path: string): LockHolder | undefined {
  return readHolderFile(path)?.holder;
}

/**
 * Moves a stale lock aside. Reclaimers race through `rename`; the one that
 * finds it moved a different file than the one it judged puts that file back.
 */
function reclaim(path: string, ino: number): void {
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (lstatSync(aside).ino !== ino) {
    try {
      linkSync(aside, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  unlinkSync(aside);
  fsyncDirectory(dirname(path));
}

export interface RecoverableLockOptions {
  purpose: string;
  /** How long to wait for a live holder, 5 seconds by default. */
  waitMs?: number;
  signal?: AbortSignal;
  containerRunning?: ContainerRunning;
}

export async function acquireRecoverableLock(
  path: string,
  options: RecoverableLockOptions,
): Promise<() => void> {
  const deadline = performance.now() + (options.waitMs ?? 5_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const self = currentLockHolder(options.purpose);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (descriptor !== undefined) {
      let ino: number;
      try {
        writeSync(descriptor, JSON.stringify(self));
        fsyncSync(descriptor);
        ino = fstatSync(descriptor).ino;
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(dirname(path));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = readHolderFile(path);
        if (current?.ino !== ino) throw new Error(`${basename(path)} was taken from this holder`);
        unlinkSync(path);
        fsyncDirectory(dirname(path));
      };
    }
    const existing = readHolderFile(path);
    if (!existing) continue;
    if (
      !existing.holder ||
      (await lockHolderGone(existing.holder, self, options.containerRunning))
    ) {
      // An unreadable holder record is only trusted as stale once it has stayed
      // unreadable past the wait, so a holder still writing it is not displaced.
      if (existing.holder || performance.now() >= deadline) {
        reclaim(path, existing.ino);
        continue;
      }
    }
    if (performance.now() >= deadline) throw new LockBusyError(path, existing.holder);
    await delay(25, undefined, { signal: options.signal });
  }
}

export async function withRecoverableLock<T>(
  path: string,
  options: RecoverableLockOptions,
  run: () => Promise<T> | T,
): Promise<T> {
  const release = await acquireRecoverableLock(path, options);
  try {
    return await run();
  } finally {
    release();
  }
}

/** The operator exit for a lock whose holder cannot be proved gone. */
export function clearRecoverableLock(path: string): LockHolder | undefined {
  const existing = readHolderFile(path);
  if (!existing) return undefined;
  reclaim(path, existing.ino);
  return existing.holder;
}
