import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob, adminJobLog } from "../db/schema";

export const ADMIN_JOB_LOG_LIMITS = { events: 2000, bytes: 1024 * 1024 } as const;
export interface JobExecution {
  owner: string;
  version: number;
}
export class JobOwnershipLost extends Error {
  constructor() {
    super("Administrative job ownership changed");
  }
}
export class JobStepAllocationConflict extends Error {
  constructor(readonly checkpoint: Record<string, unknown>) {
    super("Stable administrative step already reserved");
  }
}
export class JobStepCapacityExceeded extends Error {
  constructor() {
    super("Administrative step capacity exhausted");
  }
}
export function hasPendingReceiptDelivery(result: unknown): boolean {
  const projection = (
    result as {
      opsProjection?: {
        version?: number;
        operations?: Record<string, { receiptDelivery?: { state?: string } }>;
      };
    } | null
  )?.opsProjection;
  return (
    projection?.version === 3 &&
    Object.values(projection.operations ?? {}).some((o) => o.receiptDelivery?.state === "pending")
  );
}
export function hasUnsettledManagedOperation(result: unknown): boolean {
  const p = (
    result as {
      opsProjection?: { version?: number; operations?: Record<string, { terminal?: boolean }> };
    } | null
  )?.opsProjection;
  const data = (result as { _dataExecutions?: unknown } | null)?._dataExecutions;
  return (
    (p?.version === 3 && Object.values(p.operations ?? {}).some((o) => o.terminal !== true)) ||
    (data !== undefined &&
      (!Array.isArray(data) ||
        data.some(
          (child) =>
            !child ||
            child.state !== "terminal" ||
            !["not_started", "committed"].includes(child.publication) ||
            !["ok", "partial", "error", "canceled", "interrupted"].includes(child.status) ||
            typeof child.id !== "string" ||
            typeof child.operationKey !== "string" ||
            typeof child.fingerprint !== "string",
        )))
  );
}
export function noUnsettledManagedOperation() {
  return sql`NOT (coalesce(${adminJob.result}->'opsProjection'->>'version','') = '3' AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(${adminJob.result}->'opsProjection'->'operations','{}'::jsonb)) AS active_entry WHERE coalesce(active_entry.value->>'terminal','false') <> 'true')) AND CASE WHEN ${adminJob.result}->'_dataExecutions' IS NULL THEN true WHEN jsonb_typeof(${adminJob.result}->'_dataExecutions') <> 'array' THEN false ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${adminJob.result}->'_dataExecutions') AS backend_entry WHERE backend_entry->>'state' IS DISTINCT FROM 'terminal' OR coalesce(backend_entry->>'publication','unknown') NOT IN ('not_started','committed') OR coalesce(backend_entry->>'status','') NOT IN ('ok','partial','error','canceled','interrupted') OR coalesce(backend_entry->>'id','') !~ '^[a-f0-9-]{36}$' OR coalesce(backend_entry->>'operationKey','') !~ '^opk1_[A-Za-z0-9_-]{16,64}$' OR coalesce(backend_entry->>'fingerprint','') !~ '^[a-f0-9]{64}$') END`;
}
export function noPendingReceiptDelivery() {
  return sql`NOT (coalesce(${adminJob.result}->'opsProjection'->>'version','') = '3' AND EXISTS (SELECT 1 FROM jsonb_each(coalesce(${adminJob.result}->'opsProjection'->'operations','{}'::jsonb)) AS receipt_entry WHERE receipt_entry.value->'receiptDelivery'->>'state' = 'pending'))`;
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
    sql`(${adminJob.status} = 'cancel_pending' OR ${adminJob.result}->'observation'->>'state' IN ('unknown','receipt_delivery') OR ${adminJob.result}->>'_observationLeaseUntil' IS NOT NULL)`,
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
      SELECT ${adminJob.id}, ${adminJob.result} FROM ${adminJob} WHERE ${jobOwnership(entry.jobId, execution)} FOR UPDATE
    ), inserted AS (
      INSERT INTO ${adminJobLog} (id, job_id, seq, stream, line, created_at)
      SELECT ${entry.id}, ${entry.jobId}, ${entry.seq}, ${entry.stream}, ${entry.line}, ${entry.createdAt?.toISOString()}::timestamp
      FROM owner WHERE coalesce(owner.result->'opsProjection'->>'version','') <> '3' OR (
        coalesce((owner.result->>'_opsLogEvents')::integer,0) < ${ADMIN_JOB_LOG_LIMITS.events}
        AND coalesce((owner.result->>'_opsLogBytes')::integer,0) + ${Buffer.byteLength(entry.line, "utf8")} <= ${ADMIN_JOB_LOG_LIMITS.bytes}
      ) ON CONFLICT (id) DO NOTHING RETURNING job_id
    ), charged AS (
      UPDATE ${adminJob} SET result=coalesce(${adminJob.result},'{}'::jsonb) || jsonb_build_object(
        '_opsLogEvents',coalesce((owner.result->>'_opsLogEvents')::integer,0)+1,
        '_opsLogBytes',coalesce((owner.result->>'_opsLogBytes')::integer,0)+${Buffer.byteLength(entry.line, "utf8")})
      FROM owner,inserted WHERE ${adminJob.id}=owner.id AND inserted.job_id=owner.id AND owner.result->'opsProjection'->>'version'='3'
      RETURNING ${adminJob.id}
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
