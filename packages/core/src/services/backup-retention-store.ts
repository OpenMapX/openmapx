/** Node-only migration of portable expiry ceilings under the backup-store lock. */
import { join } from "node:path";
import { AnchoredDirectory, sameInode } from "../build-artifacts/filesystem";
import { BACKUP_FORMAT_VERSION } from "./backup-format";
import { backupRetentionExpiry } from "./backup-retention";
import { withRecoverableLock } from "./recoverable-lock";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BACKUP_STORE_LOCK_FILE = ".backup-store.lock";

/** The lock every backup create, restore, delete, prune and retention change holds. */
export function backupStoreLockPath(infraDir: string): string {
  return join(infraDir, "backups", BACKUP_STORE_LOCK_FILE);
}

/** Whether a name in the backups directory is the store lock or one of its reclaim files. */
export function isBackupStoreLockEntry(name: string): boolean {
  return name.startsWith(BACKUP_STORE_LOCK_FILE);
}

/**
 * Runs `run` holding the backup-store lock. It is held across a whole backup
 * effect, so a second one waits up to a minute and is then refused as busy. A
 * holder that died is reclaimed under the recoverable lock's rules.
 */
export function withBackupStoreLock<T>(
  infraDir: string,
  run: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  return withRecoverableLock(
    backupStoreLockPath(infraDir),
    { purpose: "backup-store", waitMs: 60_000, ...(signal ? { signal } : {}) },
    run,
  );
}
export function retainBackupExpiryCeilings(infraDir: string, retentionDays: number): void {
  backupRetentionExpiry(new Date(0).toISOString(), retentionDays);
  const infra = new AnchoredDirectory(infraDir);
  let root: AnchoredDirectory | undefined;
  try {
    try {
      root = infra.directory("backups");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of root.listBounded(129)) {
      if (isBackupStoreLockEntry(name)) continue;
      if (!namePattern.test(name)) throw Error("Backup retention inventory is unsafe");
      const directory = root.directory(name);
      try {
        let bytes: Buffer;
        try {
          bytes = directory.read("manifest.json", 1024 * 1024, false);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          continue;
        } // Corrupt entries remain separate from restorable archives.
        if (
          !manifest ||
          typeof manifest !== "object" ||
          Array.isArray(manifest) ||
          manifest.name !== name ||
          manifest.formatVersion !== BACKUP_FORMAT_VERSION ||
          typeof manifest.createdAt !== "string" ||
          !Array.isArray(manifest.services)
        )
          continue;
        let expiresAt: string;
        try {
          expiresAt = backupRetentionExpiry(manifest.createdAt, retentionDays, manifest.expiresAt);
        } catch {
          continue;
        } // Invalid expiry metadata is not a restorable manifest.
        if (expiresAt === manifest.expiresAt) continue;
        const original = directory.fileIdentity("manifest.json", false);
        directory.write(
          "manifest.json",
          `${JSON.stringify({ ...manifest, expiresAt }, null, 2)}\n`,
          false,
          () => {
            if (
              !sameInode(original, directory.fileIdentity("manifest.json", false)) ||
              !directory.read("manifest.json", 1024 * 1024, false).equals(bytes)
            )
              throw Error("Backup changed during expiry migration");
          },
        );
      } finally {
        directory.close();
      }
    }
  } finally {
    root?.close();
    infra.close();
  }
}

/** Caller already holds the configuration writer; lock order is writer→backup. */
export async function withBackupRetentionPolicyChange<T>(
  infraDir: string,
  oldDays: number,
  newDays: number,
  run: () => Promise<T>,
): Promise<T> {
  if (oldDays === newDays) return run();
  const infra = new AnchoredDirectory(infraDir);
  let root: AnchoredDirectory | undefined;
  try {
    try {
      root = infra.directory("backups");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return run();
      throw error;
    }
    // Use the actual store path while retaining its opened identity. Both remain
    // checked before and after the lock's critical section.
    const opened = root;
    return await withBackupStoreLock(infraDir, async () => {
      opened.check();
      retainBackupExpiryCeilings(infraDir, Math.min(oldDays, newDays));
      const value = await run();
      opened.check();
      return value;
    });
  } finally {
    root?.close();
    infra.close();
  }
}
