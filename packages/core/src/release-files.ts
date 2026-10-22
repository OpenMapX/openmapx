/**
 * Node-only primitives for mutable release state. Callers own parent-directory
 * trust, writer serialization and authority checks. These are not immutable
 * publication or path-confinement helpers.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Sync a real directory, rejecting a symlink at the final path component. */
export function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the sync failure; close was attempted and must not be retried.
    }
    throw error;
  }
  closeSync(descriptor);
}

/**
 * Replace mutable state via an exclusive, private temporary in the same directory.
 * A failure after rename may leave the new contents visible with durability
 * unconfirmed; do not infer rollback from a thrown error.
 */
export function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  // Open before entering cleanup: if exclusive creation fails, this path is not ours.
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let failure: { error: unknown } | undefined;
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    failure = { error };
  }
  try {
    // Never retry close: a failed close may already have released the descriptor.
    closeSync(descriptor);
  } catch (error) {
    failure ??= { error };
  }
  if (!failure) {
    try {
      renameSync(temporary, path);
      fsyncDirectory(dirname(path));
    } catch (error) {
      failure = { error };
    }
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= { error };
  }
  if (failure) throw failure.error;
}

/** Missing entries are harmless; errors syncing a completed deletion are not. */
export function durableUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fsyncDirectory(dirname(path));
}
