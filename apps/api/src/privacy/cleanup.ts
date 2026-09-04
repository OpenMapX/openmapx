import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestSourceSnapshot,
} from "../db/schema.js";
import type { EncryptedBlobStore } from "./artifact-storage.js";
import { PrivacyReauthenticationService } from "./reauthentication.js";
import { privacyRetention } from "./settings.js";

const SOURCE_SNAPSHOT_CLEANUP_BATCH_SIZE = 100;
const SOURCE_SNAPSHOT_MAX_DELETE_ATTEMPTS = 5;
const SOURCE_SNAPSHOT_EXHAUSTED_RETRY_MS = 24 * 60 * 60 * 1_000;

export interface CleanupArtifact {
  id: string;
  state: "expired" | "failed" | "revoked";
  storageKey: string;
}

export async function runPrivacyCleanup(input: {
  artifacts: readonly CleanupArtifact[];
  deleteArtifact(storageKey: string): Promise<void>;
  markDeleted(id: string): Promise<void>;
  incident(id: string, code: string): Promise<void>;
}): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const artifact of input.artifacts) {
    if (!["expired", "failed", "revoked"].includes(artifact.state)) continue;
    try {
      await input.deleteArtifact(artifact.storageKey);
      await input.markDeleted(artifact.id);
      deleted += 1;
    } catch {
      failed += 1;
      await input.incident(artifact.id, "artifact-delete-failed");
    }
  }
  return { deleted, failed };
}

/**
 * Reconcile stale partials at process start and then remove terminal database
 * objects.  The callback is intentionally injected: a failed physical delete
 * keeps metadata quarantined and visible instead of being marked complete.
 */
export async function reconcilePrivacyStorage(input: {
  removePartials: () => Promise<number>;
  artifacts: readonly CleanupArtifact[];
  deleteArtifact: (storageKey: string) => Promise<void>;
  markDeleted: (id: string) => Promise<void>;
  incident: (id: string, code: string) => Promise<void>;
}): Promise<{ partials: number; deleted: number; failed: number }> {
  const partials = await input.removePartials();
  const result = await runPrivacyCleanup(input);
  return { partials, ...result };
}

/**
 * Expire and physically remove case ciphertext.  Database state is changed to
 * a terminal value before deletion so a crash cannot make a still-deliverable
 * row point at an object that has already passed its retention deadline.  A
 * failed physical delete remains visible as `failed` and is retried on the
 * next run.
 */
export async function runPrivacyDatabaseCleanup(input: {
  database?: typeof defaultDb;
  store?: EncryptedBlobStore;
  now?: Date;
  incident?: (id: string, code: string) => Promise<void>;
}): Promise<{
  artifacts: number;
  attachments: number;
  sourceSnapshots: number;
  challenges: number;
  failed: number;
}> {
  const database = input.database ?? defaultDb;
  const now = input.now ?? new Date();
  let artifactsDeleted = 0;
  let attachmentsDeleted = 0;
  let sourceSnapshotsDeleted = 0;
  let sourceSnapshotAttemptFailed = false;
  let failed = 0;
  await database
    .update(dataExportArtifact)
    .set({ state: "expired", revokedAt: now })
    .where(
      and(
        inArray(dataExportArtifact.state, ["ready", "assembling"]),
        lte(dataExportArtifact.expiresAt, now),
      ),
    )
    .returning({ id: dataExportArtifact.id });
  const artifactRows = await database
    .select({
      id: dataExportArtifact.id,
      state: dataExportArtifact.state,
      storageKey: dataExportArtifact.storageKey,
    })
    .from(dataExportArtifact)
    .where(inArray(dataExportArtifact.state, ["expired", "failed", "revoked"]));
  for (const artifact of artifactRows) {
    if (!input.store) {
      failed += 1;
      await input.incident?.(artifact.id, "artifact-storage-unavailable");
      continue;
    }
    try {
      await input.store.delete(artifact.storageKey);
      await database
        .update(dataExportArtifact)
        .set({
          state: "deleted",
          deletedAt: now,
          wrappedDek: null,
          masterKeyVersion: null,
          tag: null,
        })
        .where(eq(dataExportArtifact.id, artifact.id));
      artifactsDeleted += 1;
    } catch {
      failed += 1;
      await database
        .update(dataExportArtifact)
        .set({ state: "failed" })
        .where(eq(dataExportArtifact.id, artifact.id));
      await input.incident?.(artifact.id, "artifact-delete-failed");
    }
  }
  const attachmentRows = await database
    .select({
      id: dataSubjectRequestAttachment.id,
      storageKey: dataSubjectRequestAttachment.storageKey,
    })
    .from(dataSubjectRequestAttachment)
    .where(
      and(
        isNull(dataSubjectRequestAttachment.deletedAt),
        lte(dataSubjectRequestAttachment.expiresAt, now),
      ),
    );
  for (const attachment of attachmentRows) {
    if (!input.store) {
      failed += 1;
      await input.incident?.(attachment.id, "attachment-storage-unavailable");
      continue;
    }
    try {
      await input.store.delete(attachment.storageKey);
      await database
        .update(dataSubjectRequestAttachment)
        .set({ deletedAt: now, wrappedDek: null, masterKeyVersion: null, tag: null })
        .where(eq(dataSubjectRequestAttachment.id, attachment.id));
      attachmentsDeleted += 1;
    } catch {
      failed += 1;
      await input.incident?.(attachment.id, "attachment-delete-failed");
    }
  }
  const sourceSnapshots = await database
    .select()
    .from(dataSubjectRequestSourceSnapshot)
    .where(
      and(
        inArray(dataSubjectRequestSourceSnapshot.state, ["captured", "delete_failed"]),
        or(
          sql`${dataSubjectRequestSourceSnapshot.deleteAttempts} < ${SOURCE_SNAPSHOT_MAX_DELETE_ATTEMPTS}`,
          and(
            eq(
              dataSubjectRequestSourceSnapshot.deleteAttempts,
              SOURCE_SNAPSHOT_MAX_DELETE_ATTEMPTS,
            ),
            or(
              isNull(dataSubjectRequestSourceSnapshot.lastDeleteAttemptAt),
              lte(
                dataSubjectRequestSourceSnapshot.lastDeleteAttemptAt,
                new Date(now.getTime() - SOURCE_SNAPSHOT_EXHAUSTED_RETRY_MS),
              ),
            ),
          ),
        ),
        or(
          lte(dataSubjectRequestSourceSnapshot.expiresAt, now),
          sql`exists (
            select 1 from data_subject_request source_request
            where source_request.id = ${dataSubjectRequestSourceSnapshot.requestId}
              and source_request.state in ('delivered', 'artifact_expired', 'withdrawn', 'refused', 'closed')
          )`,
        ),
      ),
    )
    .limit(SOURCE_SNAPSHOT_CLEANUP_BATCH_SIZE);
  for (const snapshot of sourceSnapshots) {
    const nextAttempts = Math.min(SOURCE_SNAPSHOT_MAX_DELETE_ATTEMPTS, snapshot.deleteAttempts + 1);
    if (!input.store) {
      failed += 1;
      sourceSnapshotAttemptFailed = true;
      await database
        .update(dataSubjectRequestSourceSnapshot)
        .set({
          state: "delete_failed",
          deleteAttempts: nextAttempts,
          lastDeleteAttemptAt: now,
        })
        .where(eq(dataSubjectRequestSourceSnapshot.id, snapshot.id));
      await input.incident?.(snapshot.id, "source-snapshot-storage-unavailable");
      continue;
    }
    try {
      await input.store.delete(snapshot.storageKey);
      await database
        .update(dataSubjectRequestSourceSnapshot)
        .set({
          state: "deleted",
          deletedAt: now,
          deleteAttempts: nextAttempts,
          lastDeleteAttemptAt: now,
          wrappedDek: null,
          masterKeyVersion: null,
          tag: null,
        })
        .where(eq(dataSubjectRequestSourceSnapshot.id, snapshot.id));
      sourceSnapshotsDeleted += 1;
    } catch {
      failed += 1;
      sourceSnapshotAttemptFailed = true;
      await database
        .update(dataSubjectRequestSourceSnapshot)
        .set({
          state: "delete_failed",
          deleteAttempts: nextAttempts,
          lastDeleteAttemptAt: now,
        })
        .where(eq(dataSubjectRequestSourceSnapshot.id, snapshot.id));
      await input.incident?.(snapshot.id, "source-snapshot-delete-failed");
    }
  }
  const [unresolvedSourceSnapshot] = await database
    .select({ id: dataSubjectRequestSourceSnapshot.id })
    .from(dataSubjectRequestSourceSnapshot)
    .where(
      and(
        inArray(dataSubjectRequestSourceSnapshot.state, ["captured", "delete_failed"]),
        or(
          lte(dataSubjectRequestSourceSnapshot.expiresAt, now),
          sql`exists (
            select 1 from data_subject_request source_request
            where source_request.id = ${dataSubjectRequestSourceSnapshot.requestId}
              and source_request.state in ('delivered', 'artifact_expired', 'withdrawn', 'refused', 'closed')
          )`,
        ),
      ),
    )
    .limit(1);
  // A saturated row waits for its low-frequency retry, but it remains an
  // unresolved cleanup failure until physical deletion and key clearing have
  // both been durably recorded.
  if (unresolvedSourceSnapshot && !sourceSnapshotAttemptFailed) failed += 1;
  // Case metadata has its own retention period. Never cascade away a row
  // while ciphertext still needs physical cleanup or another access request
  // for this subject remains open.
  const caseCutoff = new Date(
    now.getTime() - (await privacyRetention("case", database)) * 86_400_000,
  );
  await database
    .delete(dataSubjectRequest)
    .where(
      and(
        inArray(dataSubjectRequest.state, ["closed", "withdrawn", "refused"]),
        sql`coalesce(${dataSubjectRequest.closedAt}, ${dataSubjectRequest.withdrawalAt}, ${dataSubjectRequest.updatedAt}) < ${caseCutoff.toISOString()}`,
        sql`not exists (select 1 from data_export_artifact a where a.request_id = ${dataSubjectRequest.id} and a.state <> 'deleted')`,
        sql`not exists (select 1 from data_subject_request_attachment a where a.request_id = ${dataSubjectRequest.id} and a.deleted_at is null)`,
        sql`not exists (select 1 from data_subject_request_source_snapshot s where s.request_id = ${dataSubjectRequest.id} and s.state <> 'deleted')`,
        sql`not exists (select 1 from data_subject_request active where active.id <> ${dataSubjectRequest.id} and active.state not in ('closed', 'withdrawn', 'refused') and (active.user_id = ${dataSubjectRequest.userId} or active.locator_digest = ${dataSubjectRequest.locatorDigest}))`,
      ),
    );
  const challenges = await new PrivacyReauthenticationService(database, () => now).cleanupExpired();
  return {
    artifacts: artifactsDeleted,
    attachments: attachmentsDeleted,
    sourceSnapshots: sourceSnapshotsDeleted,
    challenges,
    failed,
  };
}
