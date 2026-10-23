import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob, adminJobLog } from "../db/schema";

export interface JobExecution {
  owner: string;
  version: number;
}
export class JobOwnershipLost extends Error {
  constructor() {
    super("Administrative job ownership changed");
  }
}
export function readJobExecution(result: unknown): JobExecution | undefined {
  if (
    result !== null &&
    result !== undefined &&
    (typeof result !== "object" || Array.isArray(result))
  )
    throw new JobOwnershipLost();
  const value = (result as { _execution?: JobExecution } | null)?._execution;
  if (value === undefined) return undefined;
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.owner,
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0
  )
    throw new JobOwnershipLost();
  return value;
}
export function jobOwnership(
  id: string,
  execution: JobExecution | undefined,
  statuses = ["running"],
) {
  return and(
    eq(adminJob.id, id),
    inArray(adminJob.status, statuses),
    execution
      ? sql`${adminJob.result}->'_execution' = ${JSON.stringify(execution)}::jsonb`
      : sql`${adminJob.result}->'_execution' IS NULL`,
  );
}
export const ADMIN_JOB_LEASE_MS = 60_000;
export function adminJobObservationDue(now = new Date().toISOString()) {
  return and(
    sql`(${adminJob.status} = 'cancel_pending' OR ${adminJob.result}->'observation'->>'state' = 'unknown' OR ${adminJob.result}->>'_observationLeaseUntil' IS NOT NULL)`,
    sql`coalesce(${adminJob.result}->'observation'->>'nextCheckAt', '') <= ${now}`,
    sql`coalesce(${adminJob.result}->>'_observationLeaseUntil', '') <= ${now}`,
  );
}
export async function renewAdminJobClaim(id: string, execution: JobExecution | undefined) {
  const now = new Date().toISOString();
  const rows = await db
    .update(adminJob)
    .set({
      result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _observationLeaseUntil: new Date(Date.now() + ADMIN_JOB_LEASE_MS).toISOString() })}::jsonb`,
    })
    .where(
      and(jobOwnership(id, execution), sql`${adminJob.result}->>'_observationLeaseUntil' > ${now}`),
    )
    .returning({ id: adminJob.id });
  if (!rows.length) throw new JobOwnershipLost();
}

/** Row locking serializes the insert with claims/cancel/settlement. The returned
 * insertion, not a preflight SELECT, is the event publication authority. */
export async function insertOwnedJobLog(
  execution: JobExecution | undefined,
  entry: typeof adminJobLog.$inferInsert,
): Promise<boolean> {
  const [result] = await db.execute<{ owned: boolean; inserted: boolean }>(sql`
    WITH owner AS MATERIALIZED (
      SELECT ${adminJob.id} FROM ${adminJob} WHERE ${jobOwnership(entry.jobId, execution)} FOR UPDATE
    ), inserted AS (
      INSERT INTO ${adminJobLog} (id, job_id, seq, stream, line, created_at)
      SELECT ${entry.id}, ${entry.jobId}, ${entry.seq}, ${entry.stream}, ${entry.line}, ${entry.createdAt?.toISOString()}::timestamp
      FROM owner ON CONFLICT (id) DO NOTHING RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM owner) AS owned, EXISTS (SELECT 1 FROM inserted) AS inserted
  `);
  if (!result?.owned) throw new JobOwnershipLost();
  return result.inserted;
}

/** Both fields change in one PostgreSQL statement; the old JSON member is the CAS token. */
export async function claimAdminJob(
  job: { id: string; result: unknown; status: string },
  patch: Partial<typeof adminJob.$inferInsert> = {},
  observation = false,
) {
  const previous = readJobExecution(job.result);
  if (previous?.version === Number.MAX_SAFE_INTEGER) throw new JobOwnershipLost();
  const execution = { owner: randomUUID(), version: (previous?.version ?? 0) + 1 };
  const [claimed] = await db
    .update(adminJob)
    .set({
      ...patch,
      result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _execution: execution, _observationLeaseUntil: new Date(Date.now() + ADMIN_JOB_LEASE_MS).toISOString() })}::jsonb`,
    })
    .where(
      and(
        jobOwnership(job.id, previous, [job.status]),
        ...(observation ? [adminJobObservationDue()] : []),
      ),
    )
    .returning();
  return claimed;
}
