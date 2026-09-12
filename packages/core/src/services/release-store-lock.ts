import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const RELEASE_STORE_LOCK_NAME = ".release-store.lock";
const RELEASE_STORE_LOCK_TTL_MS = 15 * 60_000;
const RELEASE_STORE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const RELEASE_STORE_LOCK_RETRY_MS = 50;
const MAX_RELEASE_STATE_BYTES = 4 * 1024;

function strictReadFile(path: string, maximum: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new Error("Release authority rejected");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Release authority rejected");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error("Release authority rejected");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("Release authority rejected");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let writeError: unknown;
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    writeError = error;
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && writeError === undefined) {
      writeError = error;
    }
  }
  if (writeError !== undefined) throw writeError;
}

function durableUnlink(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * A no-replace, cross-process lock over the release store.
 *
 * `mkdir` is atomic and fails with `EEXIST` when the directory already exists,
 * so it serializes ops-agent processes without a shared runtime. The owner
 * record inside it carries a lease: a holder that died without releasing is
 * reclaimed only after the lease expires, and reclamation itself races through
 * the same `mkdir`, so two reclaimers cannot both win.
 */
export interface ReleaseStoreLock {
  release(): void;
}

export interface ReleaseStoreLockHooks {
  afterLockDirectoryCreate?: () => void;
  beforeOwnerRecordWrite?: () => void;
}

export async function acquireStoreLock(
  directory: string,
  lockName: string,
  hooks: ReleaseStoreLockHooks = {},
  nowMs: () => number = Date.now,
  failIfBusy = false,
): Promise<ReleaseStoreLock> {
  const lockPath = join(directory, lockName);
  const ownerPath = join(lockPath, "owner.json");
  const deadline = nowMs() + RELEASE_STORE_LOCK_ACQUIRE_TIMEOUT_MS;
  const owner = { pid: process.pid, nonce: randomUUID() };
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      hooks.afterLockDirectoryCreate?.();
      hooks.beforeOwnerRecordWrite?.();
      atomicWrite(ownerPath, JSON.stringify({ ...owner, acquiredAtMs: nowMs() }));
      fsyncDirectory(lockPath);
      return {
        release() {
          durableUnlink(ownerPath);
          try {
            rmSync(lockPath, { recursive: true, force: true });
            fsyncDirectory(directory);
          } catch {
            // A already-removed lock directory is not an error: the caller's
            // critical section is over either way.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (failIfBusy) throw new Error("Release store is busy");
    // Held by someone else. Reclaim only an expired lease, and only by
    // removing the exact directory we observed as expired.
    let expired = false;
    try {
      const raw = strictReadFile(ownerPath, MAX_RELEASE_STATE_BYTES);
      const record = JSON.parse(raw) as { acquiredAtMs?: unknown };
      expired =
        typeof record.acquiredAtMs !== "number" ||
        !Number.isFinite(record.acquiredAtMs) ||
        nowMs() - record.acquiredAtMs > RELEASE_STORE_LOCK_TTL_MS;
    } catch (error) {
      // A lock directory without a readable owner record is either mid-
      // acquisition or abandoned before its record landed. Treat it as
      // expired only once it is older than the lease.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        let createdAtMs = Number.POSITIVE_INFINITY;
        try {
          createdAtMs = lstatSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        expired = nowMs() - createdAtMs > RELEASE_STORE_LOCK_TTL_MS;
      } else {
        throw new Error("Release store lock is unreadable");
      }
    }
    if (expired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
        fsyncDirectory(directory);
      } catch {
        // Another process reclaimed it first; retry through mkdir.
      }
      continue;
    }
    if (nowMs() >= deadline) throw new Error("Release store is busy");
    await new Promise((resolve) => setTimeout(resolve, RELEASE_STORE_LOCK_RETRY_MS));
  }
}

export function acquireReleaseStoreLock(
  directory: string,
  hooks: ReleaseStoreLockHooks = {},
  options: { failIfBusy?: boolean } = {},
): Promise<ReleaseStoreLock> {
  return acquireStoreLock(directory, RELEASE_STORE_LOCK_NAME, hooks, Date.now, options.failIfBusy);
}
