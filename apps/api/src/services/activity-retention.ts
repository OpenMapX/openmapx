import { lt } from "drizzle-orm";
import { db } from "../db";
import { adminAuditLog, adminJob, appLog, verification } from "../db/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseRequiredRetentionDays(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim();
  const days = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
    throw new Error(`${name} must be an integer between 1 and 36500`);
  }
  return days;
}

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

/** Delete persisted operational log records after the disclosed retention period. */
export async function pruneAppLogs(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    console.warn(
      `Skipping application log prune: retention days must be a positive finite number, got ${days}`,
    );
    return 0;
  }
  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const result = await db
    .delete(appLog)
    .where(lt(appLog.createdAt, cutoff))
    .returning({ id: appLog.id });
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
