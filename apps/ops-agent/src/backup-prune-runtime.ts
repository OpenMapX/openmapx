import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fsyncSync } from "node:fs";
import { rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AnchoredDirectory,
  beginControlEffect,
  executionAuthorityState,
  retainConfigurationPreEffectRefusal,
} from "@openmapx/core/build-artifacts";
import { type BackupPruneProof, canonicalJson, opsOperationFingerprint } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { OpsExecutionFailure, OpsNotWiredError, type OpsRuntime } from "./runtime";

const lifetime = 15 * 60 * 1000;
function signature(token: string, value: Omit<BackupPruneProof, "authenticator">) {
  return createHmac("sha256", token)
    .update("openmapx-backup-prune-preview-v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}
export function assertBackupPrunePreview(
  token: string,
  proof: BackupPruneProof,
  now = Date.now(),
): void {
  const { authenticator, ...unsigned } = proof,
    created = Date.parse(unsigned.previewedAt),
    expiry = Date.parse(unsigned.expiresAt);
  if (
    !Number.isSafeInteger(now) ||
    !Number.isFinite(created) ||
    !Number.isFinite(expiry) ||
    created > now + 5000 ||
    expiry !== created + lifetime ||
    now >= expiry ||
    !/^[a-f0-9]{64}$/.test(authenticator) ||
    !timingSafeEqual(
      Buffer.from(authenticator, "hex"),
      Buffer.from(signature(token, unsigned), "hex"),
    )
  )
    throw new OpsExecutionFailure("stale", {});
}
export function installBackupPruneRuntime(
  runtime: OpsRuntime,
  options: { infraDir: string; token?: string },
): void {
  const policy = () => {
    const resolved = services.resolvePlatformConfiguration({
      saved: services.readAppliedPlatformConfiguration(options.infraDir),
    });
    const retentionDays = resolved.values.backupRetentionDays,
      policySource =
        resolved.sources.backupRetentionDays === "database"
          ? ("database" as const)
          : ("host" as const);
    return {
      retentionDays,
      policySource,
      policyRevision: createHash("sha256")
        .update(
          canonicalJson({
            retentionDays,
            policySource,
            revisionId: services.currentConfigurationGeneration(options.infraDir),
          }),
        )
        .digest("hex"),
    };
  };
  async function locked<T>(signal: AbortSignal, run: () => Promise<T>) {
    try {
      return await services.withConfigurationGenerationWriter(
        options.infraDir,
        async () => {
          const infra = new AnchoredDirectory(options.infraDir);
          let root: AnchoredDirectory | undefined;
          try {
            try {
              root = infra.directory("backups");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (!root) return run();
            const lock = await services.acquireStoreLock(
              join(options.infraDir, "backups"),
              ".backup-store.lock",
              {},
              Date.now,
              false,
              services.BACKUP_STORE_LOCK_TTL_MS,
            );
            try {
              signal.throwIfAborted();
              root.check();
              const result = await run();
              root.check();
              return result;
            } finally {
              lock.release();
            }
          } finally {
            root?.close();
            infra.close();
          }
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof services.ConfigurationGenerationError &&
        error.cause instanceof OpsExecutionFailure
      )
        throw error.cause;
      throw error;
    }
  }
  runtime["backup.prune.preview"] = async (_operation, context) =>
    locked(context.signal, async () => {
      if (!options.token) throw new OpsNotWiredError();
      const now = Date.now(),
        current = policy(),
        inventory = services.backupPruneInventory(
          options.infraDir,
          current.retentionDays,
          new Date(now),
        );
      const unsigned = {
        inventoryDigest: inventory.inventoryDigest,
        policyRevision: current.policyRevision,
        previewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + lifetime).toISOString(),
      };
      return {
        proof: { ...unsigned, authenticator: signature(options.token, unsigned) },
        cutoff: new Date(now - current.retentionDays * 86400000).toISOString(),
        retentionDays: current.retentionDays,
        policySource: current.policySource,
        candidates: inventory.candidates,
        retainedCount: inventory.retainedCount,
        corruptBackups: inventory.corruptBackups,
      };
    });
  runtime["backup.prune"] = async (operation, context) =>
    locked(context.signal, async () => {
      const authority = context.controlAuthority;
      if (!authority || !options.token) throw new OpsNotWiredError();
      const admitted = executionAuthorityState(authority);
      if (
        admitted.kind !== operation.kind ||
        admitted.execution.operationFingerprint !== opsOperationFingerprint(operation) ||
        canonicalJson(admitted.execution) !== canonicalJson(context.execution)
      )
        throw Error("Original normal backup-prune execution required");
      let inventory: ReturnType<typeof services.backupPruneInventory>;
      try {
        assertBackupPrunePreview(options.token, operation.proof);
        const unsigned = operation.proof,
          created = Date.parse(unsigned.previewedAt);
        const current = policy();
        if (current.policyRevision !== unsigned.policyRevision)
          throw new OpsExecutionFailure("stale", {});
        inventory = services.backupPruneInventory(
          options.infraDir,
          current.retentionDays,
          new Date(created),
        );
        if (inventory.inventoryDigest !== unsigned.inventoryDigest)
          throw new OpsExecutionFailure("stale", {});
        context.signal.throwIfAborted();
      } catch (error) {
        retainConfigurationPreEffectRefusal(authority);
        throw error;
      }
      beginControlEffect(authority);
      const infra = new AnchoredDirectory(options.infraDir),
        deleted: string[] = [];
      let root: AnchoredDirectory | undefined;
      try {
        if (inventory.candidates.length) root = infra.directory("backups");
        for (const candidate of inventory.candidates) {
          context.signal.throwIfAborted();
          if (!root) throw Error("Backup store disappeared");
          const directory = root.directory(candidate.backupId);
          try {
            directory.check();
            const expected = inventory.candidateIdentities[candidate.backupId];
            if (
              !expected ||
              String(directory.stat.dev) !== expected.dev ||
              String(directory.stat.ino) !== expected.ino
            )
              throw Error("Backup directory changed before prune");
            // Backup format2 is flat. Await each filesystem request so a failed
            // recursive fan-out cannot outlive the store lock. Once this archive
            // starts, finish its bounded deletion before honoring cancellation.
            for (const name of directory.listBounded(1025)) {
              directory.fileIdentity(name, false);
              await unlink(directory.name(name));
            }
            directory.check();
            await rmdir(root.name(candidate.backupId));
            fsyncSync(root.fd);
          } finally {
            directory.close();
          }
          root.check();
          deleted.push(candidate.backupId);
          context.emitLog(
            "stdout",
            `Pruned backup ${candidate.backupId} (${deleted.length}/${inventory.candidates.length})`,
          );
        }
        return {
          deleted,
          retainedCount: inventory.retainedCount,
          inventoryDigest: inventory.inventoryDigest,
        };
      } finally {
        root?.close();
        infra.close();
      }
    });
}
