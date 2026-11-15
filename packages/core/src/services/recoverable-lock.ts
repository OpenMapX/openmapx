import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
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
 * apart from one that is still working. Most are held only around short file
 * updates; the backup-store lock is held for a whole backup.
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
  /** Unique per acquisition: a freed inode number is reused at once, so it alone names no file. */
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
});
export type LockHolder = z.infer<typeof holderSchema>;

export class LockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockHolder | undefined,
    name = basename(path),
  ) {
    super(
      holder
        ? `${name} is held by ${holder.purpose} (pid ${holder.pid}${holder.containerId ? ` in container ${holder.containerId.slice(0, 12)}` : ""}, since ${new Date(holder.acquiredAt).toISOString()}). If that process is gone, run \`openmapx control status\` and \`openmapx control clear --lock ${name}\`.`
        : `${name} is busy. If no process holds it, run \`openmapx control clear --lock ${name}\`.`,
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
    nonce: randomBytes(16).toString("hex"),
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
  // Every process of a container shares its PID namespace, so the same container
  // in another namespace has restarted since and the holder ended with it.
  if (
    holder.containerId &&
    holder.containerId === self.containerId &&
    holder.pidNamespace &&
    self.pidNamespace &&
    holder.pidNamespace !== self.pidNamespace
  )
    return true;
  if (holder.pidNamespace && holder.pidNamespace === self.pidNamespace) {
    if (!processAlive(holder.pid)) return true;
    const startTime = processStartTime(holder.pid);
    return Boolean(holder.startTime && startTime && holder.startTime !== startTime);
  }
  if (holder.containerId && holder.containerId !== self.containerId)
    return (await containerRunning(holder.containerId)) === false;
  return false;
}

/** A lock file as one reader saw it: its inode and its bytes, which carry the holder's nonce. */
interface LockFile {
  holder?: LockHolder;
  ino: number;
  raw: string;
}

function sameFile(current: LockFile | undefined, judged: LockFile): boolean {
  return current !== undefined && current.ino === judged.ino && current.raw === judged.raw;
}

function readHolderFile(path: string): LockFile | undefined {
  let descriptor: number;
  try {
    // Never block on a FIFO someone placed at the lock path.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    // Waiting never turns another kind of file into a lock; leave it to the operator.
    if (!stat.isFile()) throw new Error(`${path} is not a lock file; remove it by hand`);
    if (stat.size > 4096) return { ino: stat.ino, raw: `oversized:${stat.size}` };
    const buffer = Buffer.alloc(stat.size);
    readSync(descriptor, buffer, 0, buffer.length, 0);
    const raw = buffer.toString("utf8");
    try {
      return { holder: holderSchema.parse(JSON.parse(raw)), ino: stat.ino, raw };
    } catch {
      // A holder that died between creating and writing its file left it empty.
      return { ino: stat.ino, raw };
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readLockHolder(path: string): LockHolder | undefined {
  return readHolderFile(path)?.holder;
}

/**
 * Moves the file at `path` aside if it is still the one judged; one that
 * changed meanwhile is put back. Used for the reclaim guard, and by the
 * operator's clear, which acts on a holder it named.
 */
function moveAside(path: string, judged: LockFile): void {
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sameFile(readHolderFile(aside), judged)) {
    try {
      linkSync(aside, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  unlinkSync(aside);
  fsyncDirectory(dirname(path));
}

/**
 * Removes a lock whose holder is gone. Reclaimers take turns through a guard
 * file beside the lock, and the one holding it removes the lock only if it is
 * still the file it judged: a new holder's file is never removed, because
 * nobody else removes or replaces the lock while the guard is held. Resolves
 * true when the caller should look again at once, and false while another
 * reclaimer holds the guard.
 */
async function reclaim(
  path: string,
  judged: LockFile,
  self: LockHolder,
  containerRunning?: ContainerRunning,
): Promise<boolean> {
  const guard = `${path}.reclaim`;
  let descriptor: number;
  try {
    descriptor = openSync(
      guard,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A reclaimer that died while holding the guard leaves it behind.
    const other = readHolderFile(guard);
    if (other?.holder && (await lockHolderGone(other.holder, self, containerRunning))) {
      moveAside(guard, other);
      return true;
    }
    return false;
  }
  try {
    writeSync(descriptor, JSON.stringify(self));
  } finally {
    closeSync(descriptor);
  }
  try {
    if (!sameFile(readHolderFile(path), judged)) return true;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return true;
  } finally {
    unlinkSync(guard);
  }
}

export interface RecoverableLockOptions {
  purpose: string;
  /** How long to wait for a live holder, 5 seconds by default. */
  waitMs?: number;
  /** The name busy messages give for `openmapx control clear --lock`; the file name by default. */
  name?: string;
  signal?: AbortSignal;
  containerRunning?: ContainerRunning;
}

export async function acquireRecoverableLock(
  path: string,
  options: RecoverableLockOptions,
): Promise<() => void> {
  const waitMs = options.waitMs ?? 5_000;
  const deadline = performance.now() + waitMs;
  // An unreadable holder record, and since when it has stayed exactly the same.
  let unreadable: { file: LockFile; since: number } | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const self = currentLockHolder(options.purpose);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (descriptor !== undefined) {
      let own: LockFile;
      try {
        const raw = JSON.stringify(self);
        writeSync(descriptor, raw);
        fsyncSync(descriptor);
        own = { ino: fstatSync(descriptor).ino, raw };
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(dirname(path));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!sameFile(readHolderFile(path), own))
          throw new Error(`${basename(path)} was taken from this holder`);
        unlinkSync(path);
        fsyncDirectory(dirname(path));
      };
    }
    const existing = readHolderFile(path);
    if (!existing) continue;
    // An unreadable holder record is only trusted as stale once it has stayed the
    // same past the wait, or a second, so a holder still writing it is not displaced.
    if (!existing.holder && !(unreadable && sameFile(existing, unreadable.file)))
      unreadable = { file: existing, since: performance.now() };
    const pending =
      !existing.holder && performance.now() - (unreadable?.since ?? 0) < (waitMs || 1_000);
    if (
      existing.holder
        ? await lockHolderGone(existing.holder, self, options.containerRunning)
        : !pending
    ) {
      if (await reclaim(path, existing, self, options.containerRunning)) continue;
      // Another reclaimer holds the guard; one that died there is named once the wait is over.
      const guard = `${path}.reclaim`;
      if (performance.now() >= deadline)
        throw new LockBusyError(
          guard,
          readLockHolder(guard),
          `${options.name ?? basename(path)}.reclaim`,
        );
      await delay(5, undefined, { signal: options.signal });
      continue;
    }
    if (performance.now() >= deadline && !pending)
      throw new LockBusyError(path, existing.holder, options.name);
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

/** The operator exit for a lock whose holder cannot be proved gone, and for its reclaim guard. */
export function clearRecoverableLock(path: string): LockHolder | undefined {
  const guard = readHolderFile(`${path}.reclaim`);
  if (guard) moveAside(`${path}.reclaim`, guard);
  const existing = readHolderFile(path);
  if (!existing) return undefined;
  moveAside(path, existing);
  return existing.holder;
}
