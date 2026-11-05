/** Read-only, descriptor-anchored prune inventory. Caller owns the backup-store lock. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { AnchoredDirectory, type FileIdentity, identity } from "../build-artifacts/filesystem";
import { canonicalJson } from "../ops/canonical-json";
import { backupRetentionExpiry } from "./backup-retention";

export interface BackupPruneCandidate {
  backupId: string;
  createdAt: string;
  expiresAt: string;
  totalBytes: number;
  corrupt: boolean;
}
export function backupPruneInventory(infraDir: string, retentionDays: number, at = new Date()) {
  backupRetentionExpiry(new Date(0).toISOString(), retentionDays);
  if (!Number.isFinite(at.getTime())) throw Error("Prune observation time is invalid");
  const infra = new AnchoredDirectory(infraDir),
    candidates: BackupPruneCandidate[] = [],
    corruptBackups: string[] = [],
    records: unknown[] = [];
  let root: AnchoredDirectory | undefined,
    retainedCount = 0;
  const candidateIdentities: Record<string, FileIdentity> = {};
  try {
    try {
      root = infra.directory("backups");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (root) {
      records.push({ root: identity(root.stat) });
      for (const name of root.listBounded(129).sort()) {
        if (name === ".backup-store.lock") continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
          throw Error("Backup inventory is unsafe");
        const directory = root.directory(name);
        try {
          const membersSnapshot = () =>
            directory
              .listBounded(1025)
              .sort()
              .map((file) => {
                const stat = lstatSync(directory.name(file), { bigint: true });
                if (
                  !stat.isFile() ||
                  stat.nlink !== 1n ||
                  stat.uid !== BigInt(process.getuid?.() ?? -1) ||
                  (stat.mode & 0o022n) !== 0n
                )
                  throw Error("Backup member is unsafe");
                return {
                  file,
                  ...identity(stat),
                  size: String(stat.size),
                  modified: String(stat.mtimeNs),
                  changed: String(stat.ctimeNs),
                };
              });
          const members = membersSnapshot();
          let createdAt = new Date(Number(directory.stat.mtimeMs)).toISOString(),
            stamped: unknown,
            corrupt = false,
            manifestDigest: string | null = null;
          try {
            const bytes = directory.read("manifest.json", 1024 * 1024, false);
            manifestDigest = createHash("sha256").update(bytes).digest("hex");
            const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            if (
              manifest?.formatVersion !== 2 ||
              manifest.name !== name ||
              typeof manifest.createdAt !== "string" ||
              !Array.isArray(manifest.services) ||
              !Number.isFinite(Date.parse(manifest.createdAt)) ||
              Date.parse(manifest.createdAt) > at.getTime()
            )
              throw Error("Invalid backup expiry metadata");
            backupRetentionExpiry(manifest.createdAt, retentionDays, manifest.expiresAt);
            createdAt = new Date(manifest.createdAt).toISOString();
            stamped = manifest.expiresAt;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ELOOP") throw error;
            corrupt = true;
            corruptBackups.push(name);
          }
          const observed = lstatSync(directory.path, { bigint: true });
          if (
            observed.mtimeNs !== directory.stat.mtimeNs ||
            observed.ctimeNs !== directory.stat.ctimeNs ||
            canonicalJson(membersSnapshot()) !== canonicalJson(members)
          )
            throw Error("Backup inventory changed during observation");
          const expiresAt = backupRetentionExpiry(createdAt, retentionDays, stamped),
            totalBytes = members.reduce((sum, entry) => sum + Number(entry.size), 0);
          if (!Number.isSafeInteger(totalBytes))
            throw Error("Backup inventory size exceeds its limit");
          const record = { backupId: name, createdAt, expiresAt, totalBytes, corrupt };
          records.push({
            ...record,
            directory: identity(directory.stat),
            modified: String(directory.stat.mtimeNs),
            changed: String(directory.stat.ctimeNs),
            manifestDigest,
            members,
          });
          if (Date.parse(expiresAt) < at.getTime()) {
            candidates.push(record);
            candidateIdentities[name] = identity(directory.stat);
          } else retainedCount++;
          directory.check();
        } finally {
          directory.close();
        }
      }
      root.check();
    }
    return {
      inventoryDigest: createHash("sha256")
        .update("openmapx-backup-prune-inventory-v1\0")
        .update(canonicalJson(records))
        .digest("hex"),
      candidates,
      retainedCount,
      corruptBackups,
      candidateIdentities,
    };
  } finally {
    root?.close();
    infra.close();
  }
}
