import { lt } from "drizzle-orm";
import { db } from "../db";
import { adminAuditLog, adminJob } from "../db/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete admin audit log entries older than `days`. Returns the number of
 * rows pruned. Mirrors the health-history retention pattern so the audit
 * table doesn't grow unbounded over a long-lived deployment.
 */
export async function pruneAuditLog(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    console.warn(
      `Skipping audit log prune: retention days must be a positive finite number, got ${days}`,
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const result = await db
    .delete(adminAuditLog)
    .where(lt(adminAuditLog.createdAt, cutoff))
    .returning({ id: adminAuditLog.id });
  return result.length;
}

/**
 * Delete completed admin job rows (and cascading job logs) older than `days`.
 * Only prunes terminal-state rows so an in-flight job started before the
 * cutoff is never deleted out from under the runner.
 */
export async function pruneCompletedJobs(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    console.warn(
      `Skipping admin job prune: retention days must be a positive finite number, got ${days}`,
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  // adminJobLog has ON DELETE CASCADE so deleting parent rows clears logs.
  const result = await db
    .delete(adminJob)
    .where(lt(adminJob.finishedAt, cutoff))
    .returning({ id: adminJob.id });
  return result.length;
}
