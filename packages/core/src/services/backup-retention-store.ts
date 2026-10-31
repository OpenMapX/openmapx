/** Node-only migration of portable expiry ceilings under the existing backup lock. */
import { join } from "node:path";
import { AnchoredDirectory, sameInode } from "../build-artifacts/filesystem";
import { backupRetentionExpiry } from "./backup-retention";
import { acquireStoreLock } from "./release-store-lock";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Existing backup effects allow30 minutes; retain exclusion through cleanup. */
export const BACKUP_STORE_LOCK_TTL_MS = 35 * 60000;
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
      if (name === ".backup-store.lock") continue;
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
          manifest.formatVersion !== 2 ||
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
    // checked before and after the existing lock's critical section.
    const lock = await acquireStoreLock(
      join(infraDir, "backups"),
      ".backup-store.lock",
      {},
      Date.now,
      false,
      BACKUP_STORE_LOCK_TTL_MS,
    );
    try {
      root.check();
      retainBackupExpiryCeilings(infraDir, Math.min(oldDays, newDays));
      const value = await run();
      root.check();
      return value;
    } finally {
      lock.release();
    }
  } finally {
    root?.close();
    infra.close();
  }
}
