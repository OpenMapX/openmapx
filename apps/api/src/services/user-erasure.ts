import { readFileSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { appendErasureCompleted, appendErasureRequest } from "@openmapx/core/erasure-journal";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestSourceSnapshot,
} from "../db/schema";

interface ErasureUser {
  id: string;
  email: string;
}

export interface UserErasureDependencies {
  request(userId: string): Promise<string>;
  cleanup(user: ErasureUser): Promise<void>;
  complete(receiptId: string): Promise<void>;
}

// The auth hook is constructed before the optional artifact store during API
// startup.  Once the store is ready, the server installs its lock-aware
// deleter here; the descriptor-only fallback below keeps deletion safe and
// idempotent in minimal/test environments without a configured volume.
let configuredPrivacyArtifactDeleter: ((storageKey: string) => Promise<void>) | undefined;

export function configurePrivacyArtifactDeleter(
  deleter: ((storageKey: string) => Promise<void>) | undefined,
): void {
  configuredPrivacyArtifactDeleter = deleter;
}

export function createUserErasureHooks(dependencies: UserErasureDependencies): {
  before(user: ErasureUser): Promise<void>;
  after(user: ErasureUser): Promise<void>;
} {
  const pendingReceipts = new Map<string, string>();
  return {
    async before(user) {
      const receiptId = await dependencies.request(user.id);
      pendingReceipts.set(user.id, receiptId);
      try {
        await dependencies.cleanup(user);
      } catch (error) {
        pendingReceipts.delete(user.id);
        throw error;
      }
    },
    async after(user) {
      const receiptId = pendingReceipts.get(user.id);
      if (!receiptId) return;
      pendingReceipts.delete(user.id);
      try {
        await dependencies.complete(receiptId);
      } catch {
        // The request marker is authoritative for restore replay. The account
        // is already gone, so a completion-write failure must not turn the
        // successful deletion response into a misleading error.
      }
    },
  };
}

function readJournalKey(): Buffer {
  const path = process.env.ERASURE_JOURNAL_KEY_FILE?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_KEY_FILE is required for account deletion");
  const encoded = readFileSync(path, "utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error("Erasure journal key is not canonical base64url");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("Erasure journal key must contain exactly 32 bytes");
  }
  return key;
}

function journalPath(): string {
  const path = process.env.ERASURE_JOURNAL_PATH?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_PATH is required for account deletion");
  return path;
}

export async function cleanupResidualUserData(user: ErasureUser): Promise<void> {
  // Better Auth invokes this hook before deleting the user row.  Export
  // ciphertext is deliberately outside the database and therefore is not
  // covered by FK cascades; remove it while the exact subject/request mapping
  // is still available.  A missing store/object is idempotent, but an unsafe
  // path or failed delete aborts account deletion so we never report an
  // erasure while a deliverable archive remains readable.
  const requests = await db
    .select({ id: dataSubjectRequest.id, state: dataSubjectRequest.state })
    .from(dataSubjectRequest)
    .where(eq(dataSubjectRequest.userId, user.id));
  const requestIds = requests.map((row) => row.id);
  const retainedActiveRequestIds = new Set(
    requests
      .filter(
        (request) =>
          !["delivered", "artifact_expired", "withdrawn", "refused", "closed"].includes(
            request.state,
          ),
      )
      .map((request) => request.id),
  );
  const deletionRequestIds = requestIds.filter((id) => !retainedActiveRequestIds.has(id));
  if (deletionRequestIds.length) {
    const [artifacts, attachments, sourceSnapshots] = await Promise.all([
      db
        .select({ id: dataExportArtifact.id, storageKey: dataExportArtifact.storageKey })
        .from(dataExportArtifact)
        .where(inArray(dataExportArtifact.requestId, deletionRequestIds)),
      db
        .select({
          id: dataSubjectRequestAttachment.id,
          storageKey: dataSubjectRequestAttachment.storageKey,
        })
        .from(dataSubjectRequestAttachment)
        .where(inArray(dataSubjectRequestAttachment.requestId, deletionRequestIds)),
      db
        .select({
          id: dataSubjectRequestSourceSnapshot.id,
          storageKey: dataSubjectRequestSourceSnapshot.storageKey,
        })
        .from(dataSubjectRequestSourceSnapshot)
        .where(inArray(dataSubjectRequestSourceSnapshot.requestId, deletionRequestIds)),
    ]);
    for (const object of [...artifacts, ...attachments, ...sourceSnapshots]) {
      if (configuredPrivacyArtifactDeleter)
        await configuredPrivacyArtifactDeleter(object.storageKey);
      else await deletePrivacyCiphertext(object.storageKey);
    }
    const erasedAt = new Date();
    await db.transaction(async (tx) => {
      if (artifacts.length) {
        await tx
          .update(dataExportArtifact)
          .set({
            state: "deleted",
            deletedAt: erasedAt,
            revokedAt: erasedAt,
            wrappedDek: null,
            masterKeyVersion: null,
            tag: null,
          })
          .where(
            and(
              inArray(
                dataExportArtifact.id,
                artifacts.map((row) => row.id),
              ),
              sql`${dataExportArtifact.state} <> 'deleted'`,
            ),
          );
      }
      if (attachments.length) {
        await tx
          .update(dataSubjectRequestAttachment)
          .set({ deletedAt: erasedAt, wrappedDek: null, masterKeyVersion: null, tag: null })
          .where(
            and(
              inArray(
                dataSubjectRequestAttachment.id,
                attachments.map((row) => row.id),
              ),
              sql`${dataSubjectRequestAttachment.deletedAt} is null`,
            ),
          );
      }
      if (sourceSnapshots.length) {
        await tx
          .update(dataSubjectRequestSourceSnapshot)
          .set({
            state: "deleted",
            deletedAt: erasedAt,
            wrappedDek: null,
            masterKeyVersion: null,
            tag: null,
          })
          .where(
            inArray(
              dataSubjectRequestSourceSnapshot.id,
              sourceSnapshots.map((row) => row.id),
            ),
          );
      }
    });
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM verification
      WHERE value = ${user.id}
         OR lower(identifier) = lower(${user.email})
         OR lower(identifier) = lower(${`change-email:${user.id}:${user.email}`})
    `);
    await tx.execute(sql`
      UPDATE system_settings SET updated_by = NULL WHERE updated_by = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET actor_id = NULL, ip_address = NULL, user_agent = NULL
      WHERE actor_id = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET target_id = NULL
      WHERE target_id = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET details = NULL
      WHERE position(${user.id} in details::text) > 0
         OR position(lower(${user.email}) in lower(details::text)) > 0
    `);
    await tx.execute(sql`
      DELETE FROM app_logs
      WHERE position(${user.id} in msg) > 0
         OR position(lower(${user.email}) in lower(msg)) > 0
         OR position(${user.id} in metadata::text) > 0
         OR position(lower(${user.email}) in lower(metadata::text)) > 0
    `);
  });
}

/**
 * Delete one ciphertext object using the same descriptor/path invariants as
 * the runtime artifact store, without loading the master key during the
 * Better-Auth deletion hook.  This is intentionally private to erasure: the
 * normal request cleanup path uses EncryptedBlobStore's lock and metadata
 * checks.  The storage root is fixed by deployment configuration and a
 * missing object is treated as an already-completed deletion.
 */
async function deletePrivacyCiphertext(storageKey: string): Promise<void> {
  const rootValue =
    process.env.OPENMAPX_EXPORT_STORAGE_DIR?.trim() || "/var/lib/openmapx/subject-exports";
  if (!isAbsolute(rootValue)) throw new Error("Privacy export storage root is unavailable");
  if (
    !storageKey ||
    storageKey.length > 512 ||
    isAbsolute(storageKey) ||
    storageKey.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\\\0\p{Cc}]/u.test(storageKey)
  ) {
    throw new Error("Privacy artifact storage key is unsafe");
  }
  const root = resolve(rootValue);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return null;
    throw error;
  });
  // A deployment without the optional export volume cannot have a readable
  // ciphertext object.  Keep deletion idempotent without creating a new
  // directory merely as a side effect of account removal.
  if (!rootInfo) return;
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o777) !== 0o700)
    throw new Error("Privacy export storage root is unsafe");
  const path = resolve(root, storageKey);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Privacy artifact storage key is unsafe");
  const info = await lstat(path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return null;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400)
    throw new Error("Privacy artifact path is unsafe");
  await rm(path, { force: false });
}

export const userErasureHooks = createUserErasureHooks({
  request: async (userId) => appendErasureRequest(journalPath(), readJournalKey(), userId),
  cleanup: cleanupResidualUserData,
  complete: async (receiptId) => appendErasureCompleted(journalPath(), receiptId),
});
