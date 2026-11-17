import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob, adminJobLog } from "../db/schema";

export const ADMIN_JOB_LOG_LIMITS = { events: 2000, bytes: 1024 * 1024 } as const;
export interface JobExecution {
  owner: string;
  version: number;
}
/**
 * The runner's own state for a job, kept in `admin_job.protocol` beside the
 * job's result: the claim that owns it, its observation lease, when a cancel
 * was requested, and the agent operations it recorded before each request.
 */
export interface AdminJobProtocol {
  execution?: JobExecution;
  observationLeaseUntil?: string | null;
  cancelRequestedAt?: string;
  /** Read and validated with `readProjection`. */
  operations?: unknown;
}
export function readAdminJobProtocol(value: unknown): AdminJobProtocol {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new JobOwnershipLost();
  return value as AdminJobProtocol;
}
/** When a cancel was requested for the job, or undefined. */
export function cancelRequestedAt(protocol: AdminJobProtocol | undefined): string | undefined {
  const value = protocol?.cancelRequestedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
export class JobOwnershipLost extends Error {
  constructor() {
    super("Administrative job ownership changed");
  }
}
export class JobStepAllocationConflict extends Error {
  constructor(
    readonly checkpoint: Record<string, unknown>,
    readonly protocol: AdminJobProtocol,
  ) {
    super("Stable administrative step already reserved");
  }
}
export class JobStepCapacityExceeded extends Error {
  constructor() {
    super("Administrative step capacity exhausted");
  }
}
export function hasUnsettledManagedOperation(
  result: unknown,
  protocol: AdminJobProtocol | undefined,
): boolean {
  const p = protocol?.operations as
    | { version?: number; operations?: Record<string, { terminal?: boolean }> }
    | undefined;
  const data = (result as { _dataExecutions?: unknown } | null)?._dataExecutions;
  const standalone = result as { _standalone?: unknown; _standaloneSettled?: unknown } | null;
  return (
    (standalone?._standalone !== undefined && standalone._standaloneSettled !== true) ||
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
  return sql`(${adminJob.result}->'_standalone' IS NULL OR ${adminJob.result}->'_standaloneSettled' = 'true'::jsonb) AND NOT (coalesce(${adminJob.protocol}->'operations'->>'version','') = '3' AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(${adminJob.protocol}->'operations'->'operations','{}'::jsonb)) AS active_entry WHERE coalesce(active_entry.value->>'terminal','false') <> 'true')) AND CASE WHEN ${adminJob.result}->'_dataExecutions' IS NULL THEN true WHEN jsonb_typeof(${adminJob.result}->'_dataExecutions') <> 'array' THEN false ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${adminJob.result}->'_dataExecutions') AS backend_entry WHERE backend_entry->>'state' IS DISTINCT FROM 'terminal' OR coalesce(backend_entry->>'publication','unknown') NOT IN ('not_started','committed') OR coalesce(backend_entry->>'status','') NOT IN ('ok','partial','error','canceled','interrupted') OR coalesce(backend_entry->>'id','') !~ '^[a-f0-9-]{36}$' OR coalesce(backend_entry->>'operationKey','') !~ '^opk1_[A-Za-z0-9_-]{16,64}$' OR coalesce(backend_entry->>'fingerprint','') !~ '^[a-f0-9]{64}$') END`;
}
export function readJobExecution(protocol: unknown): JobExecution | undefined {
  const value = readAdminJobProtocol(protocol).execution;
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
      ? sql`${adminJob.protocol}->'execution' = ${JSON.stringify(execution)}::jsonb`
      : sql`${adminJob.protocol}->'execution' IS NULL`,
  );
}
export const ADMIN_JOB_LEASE_MS = 60_000;
export function adminJobObservationDue(now = new Date().toISOString()) {
  return and(
    sql`(${adminJob.status} = 'cancel_pending' OR ${adminJob.result}->'observation'->>'state' = 'unknown' OR ${adminJob.protocol}->>'observationLeaseUntil' IS NOT NULL)`,
    sql`coalesce(${adminJob.result}->'observation'->>'nextCheckAt', '') <= ${now}`,
    sql`coalesce(${adminJob.protocol}->>'observationLeaseUntil', '') <= ${now}`,
  );
}
export async function renewAdminJobClaim(id: string, execution: JobExecution | undefined) {
  const now = new Date().toISOString();
  const rows = await db
    .update(adminJob)
    .set({
      protocol: sql`${adminJob.protocol} || ${JSON.stringify({ observationLeaseUntil: new Date(Date.now() + ADMIN_JOB_LEASE_MS).toISOString() })}::jsonb`,
    })
    .where(
      and(
        jobOwnership(id, execution),
        sql`${adminJob.protocol}->>'observationLeaseUntil' > ${now}`,
      ),
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
      SELECT ${adminJob.id}, ${adminJob.result}, ${adminJob.protocol} FROM ${adminJob} WHERE ${jobOwnership(entry.jobId, execution)} FOR UPDATE
    ), inserted AS (
      INSERT INTO ${adminJobLog} (id, job_id, seq, stream, line, created_at)
      SELECT ${entry.id}, ${entry.jobId}, ${entry.seq}, ${entry.stream}, ${entry.line}, ${entry.createdAt?.toISOString()}::timestamp
      FROM owner WHERE coalesce(owner.protocol->'operations'->>'version','') <> '3' OR (
        coalesce((owner.result->>'_opsLogEvents')::integer,0) < ${ADMIN_JOB_LOG_LIMITS.events}
        AND coalesce((owner.result->>'_opsLogBytes')::integer,0) + ${Buffer.byteLength(entry.line, "utf8")} <= ${ADMIN_JOB_LOG_LIMITS.bytes}
      ) ON CONFLICT (id) DO NOTHING RETURNING job_id
    ), charged AS (
      UPDATE ${adminJob} SET result=coalesce(${adminJob.result},'{}'::jsonb) || jsonb_build_object(
        '_opsLogEvents',coalesce((owner.result->>'_opsLogEvents')::integer,0)+1,
        '_opsLogBytes',coalesce((owner.result->>'_opsLogBytes')::integer,0)+${Buffer.byteLength(entry.line, "utf8")})
      FROM owner,inserted WHERE ${adminJob.id}=owner.id AND inserted.job_id=owner.id AND owner.protocol->'operations'->>'version'='3'
      RETURNING ${adminJob.id}
    )
    SELECT EXISTS (SELECT 1 FROM owner) AS owned, EXISTS (SELECT 1 FROM inserted) AS inserted
  `);
  if (!result?.owned) throw new JobOwnershipLost();
  return result.inserted;
}

/** Both fields change in one PostgreSQL statement; the old claim is the CAS token. */
export async function claimAdminJob(
  job: { id: string; protocol: unknown; status: string },
  patch: Partial<typeof adminJob.$inferInsert> = {},
  observation = false,
) {
  const previous = readJobExecution(job.protocol);
  if (previous?.version === Number.MAX_SAFE_INTEGER) throw new JobOwnershipLost();
  const execution = { owner: randomUUID(), version: (previous?.version ?? 0) + 1 };
  const [claimed] = await db
    .update(adminJob)
    .set({
      ...patch,
      protocol: sql`${adminJob.protocol} || ${JSON.stringify({ execution, observationLeaseUntil: new Date(Date.now() + ADMIN_JOB_LEASE_MS).toISOString() })}::jsonb`,
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
