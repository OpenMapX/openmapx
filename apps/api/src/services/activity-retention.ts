import { and, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adminAuditLog,
  adminJob,
  appLog,
  dataManagerJob,
  platformConfigurationPreview,
  verification,
} from "../db/schema";
import {
  preservationAllowsDeletion,
  withPreservationRetentionLock,
} from "../privacy/preservation.js";
import { processLogger } from "../process-logger";
import { noUnsettledManagedOperation } from "./admin-job-state";
import { prunePlatformConfigurationPreviews } from "./platform-preview-store";
import { pruneTransitCredentialPreviews } from "./transit-credential-retention";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete admin audit log entries older than `days`. Returns the number of
 * rows pruned. Mirrors the health-history retention pattern so the audit
 * table doesn't grow unbounded over a long-lived deployment.
 */
export async function pruneAuditLog(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    processLogger.warn(
      { days },
      "Skipping audit log prune: retention days must be a positive finite number",
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const result = await withPreservationRetentionLock(db, (tx) =>
    tx
      .delete(adminAuditLog)
      .where(
        and(
          lt(adminAuditLog.createdAt, cutoff),
          preservationAllowsDeletion({
            registrationId: "admin-audit-attribution",
            candidateTimestamp: adminAuditLog.createdAt,
            subjectIds: [adminAuditLog.actorUserId, adminAuditLog.targetId],
          }),
        ),
      )
      .returning({ id: adminAuditLog.id }),
  );
  return result.length;
}

/**
 * Delete completed admin job rows (and cascading job logs) older than `days`.
 * Only prunes terminal-state rows so an in-flight job started before the
 * cutoff is never deleted out from under the runner.
 */
export async function pruneCompletedJobs(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    processLogger.warn(
      { days },
      "Skipping admin job prune: retention days must be a positive finite number",
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  // adminJobLog has ON DELETE CASCADE so deleting parent rows clears logs.
  const result = await withPreservationRetentionLock(db, async (tx) => {
    await pruneTransitCredentialPreviews(tx);
    await prunePlatformConfigurationPreviews(tx);
    return tx
      .delete(adminJob)
      .where(
        and(
          lt(adminJob.finishedAt, cutoff),
          noUnsettledManagedOperation(),
          sql`NOT EXISTS (SELECT 1 FROM ${platformConfigurationPreview} WHERE ${platformConfigurationPreview.consumedByJobId} = ${adminJob.id})`,
          sql`(coalesce(${adminJob.protocol}->'operations'->>'version','') <> '1' OR${adminJob.finishedAt} < ${new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()}::timestamptz)`,
          preservationAllowsDeletion({
            registrationId: "admin-jobs-attribution",
            candidateTimestamp: adminJob.createdAt,
            subjectIds: [adminJob.createdByUserId],
          }),
        ),
      )
      .returning({ id: adminJob.id });
  });
  return result.length;
}

/** How long a finished data-manager job, with the account that started it, is kept. */
export const DATA_MANAGER_JOB_RETENTION_DAYS = 90;

/**
 * Delete finished data-manager jobs, and by cascade their stages, that
 * finished more than `days` ago. A job is deleted only once data-manager's
 * control prune removed its execution row and the records named by its key
 * (`released_at` set on a row without one). A finished job the control prune
 * has not swept yet (data-manager stopped, or an execution awaiting recovery)
 * stays, without the account that started it. A running job has no finish
 * time and is never touched. Returns the number of deleted jobs.
 */
export async function pruneDataManagerJobs(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    processLogger.warn(
      { days },
      "Skipping data-manager job prune: retention days must be a positive finite number",
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const unheld = preservationAllowsDeletion({
    registrationId: "data-manager-trigger-attribution",
    candidateTimestamp: dataManagerJob.admittedAt,
    subjectIds: [dataManagerJob.triggeredByUserId],
    // An operator preserves this registration's rows by hand.
    blockingStatuses: ["held", "action_required"],
  });
  const result = await withPreservationRetentionLock(db, async (tx) => {
    const deleted = await tx
      .delete(dataManagerJob)
      .where(
        and(
          lt(dataManagerJob.finishedAt, cutoff),
          isNull(dataManagerJob.executionAdmission),
          isNotNull(dataManagerJob.releasedAt),
          unheld,
        ),
      )
      .returning({ id: dataManagerJob.id });
    await tx
      .update(dataManagerJob)
      .set({ triggeredByUserId: null })
      .where(
        and(
          lt(dataManagerJob.finishedAt, cutoff),
          isNotNull(dataManagerJob.triggeredByUserId),
          unheld,
        ),
      );
    return deleted;
  });
  return result.length;
}

/** Delete persisted operational log records after the disclosed retention period. */
export async function pruneAppLogs(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    processLogger.warn(
      { days },
      "Skipping application log prune: retention days must be a positive finite number",
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const result = await withPreservationRetentionLock(db, (tx) =>
    tx
      .delete(appLog)
      .where(
        and(
          lt(appLog.createdAt, cutoff),
          preservationAllowsDeletion({
            registrationId: "application-logs",
            candidateTimestamp: appLog.createdAt,
            subjectIds: [sql`${appLog.metadata} ->> 'subjectId'`],
            // An operator preserves this registration's rows by hand; the
            // catalogue keeps them until 30 days after the request closes.
            blockingStatuses: ["held", "action_required"],
          }),
        ),
      )
      .returning({ id: appLog.id }),
  );
  return result.length;
}

/** Remove one-time authentication material as soon as its validity has ended. */
export async function pruneExpiredVerifications(): Promise<number> {
  const result = await db
    .delete(verification)
    .where(lt(verification.expiresAt, new Date()))
    .returning({ id: verification.id });
  return result.length;
}
