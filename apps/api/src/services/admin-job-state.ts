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
  /** The configuration candidate the job is carrying through its three phases. */
  candidate?: AdminJobCandidate;
  /** A job the API ran for an HTTP request: who asked, and a keyed digest of
   * the intent, so the same key with another intent is refused. */
  immediate?: { actorId: string; intentDigest: string };
  /** The handler's own recovery state (its underscore checkpoint keys), kept
   * beside the public result. Handlers see both merged as their checkpoint. */
  handler?: Record<string, unknown>;
}
/** Splits a handler's checkpoint into the public result and its own state. */
export function splitJobCheckpoint(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {},
    handler: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    if (key.startsWith("_")) handler[key] = entry;
    else result[key] = entry;
  return { result, handler };
}
/** A handler's checkpoint: the job's public result and its own state. */
export function jobCheckpoint(result: unknown, protocol: unknown): Record<string, unknown> | null {
  const handler = readAdminJobProtocol(protocol).handler;
  if ((result === null || result === undefined) && handler === undefined) return null;
  return { ...((result ?? {}) as Record<string, unknown>), ...(handler ?? {}) };
}
/** Update fields that merge a checkpoint patch into a job's result and own state. */
export function mergeJobCheckpoint(
  patch: Record<string, unknown>,
  options: { dropObservation?: boolean; protocol?: Record<string, unknown> } = {},
) {
  const { result, handler } = splitJobCheckpoint(patch);
  return {
    result: options.dropObservation
      ? sql`(coalesce(${adminJob.result}, '{}'::jsonb) - 'observation') || ${JSON.stringify(result)}::jsonb`
      : sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb`,
    protocol: sql`${adminJob.protocol} || jsonb_build_object('handler', coalesce(${adminJob.protocol}->'handler', '{}'::jsonb) || ${JSON.stringify(handler)}::jsonb) || ${JSON.stringify(options.protocol ?? {})}::jsonb`,
  };
}
/** Update fields that replace a job's result and own state with a checkpoint. */
export function replaceJobCheckpoint(value: Record<string, unknown>) {
  const { result, handler } = splitJobCheckpoint(value);
  return {
    result,
    protocol: sql`${adminJob.protocol} || jsonb_build_object('handler', ${JSON.stringify(handler)}::jsonb)`,
  };
}
/**
 * A configuration candidate's progress. `candidate_prepared`: the candidate is
 * held at the agent, nothing is saved. `rows_saved`: the desired rows were
 * written in the same transaction as this phase. `generation_applied`: the
 * apply concluded and its outcome is in the job's result.
 */
export type CandidatePhase = "candidate_prepared" | "rows_saved" | "generation_applied";
export interface AdminJobCandidate {
  phase: CandidatePhase;
  candidateId: string;
  /** The job step's key, the writer's operation key. */
  operationKey: string;
  /** The key the agent holds the candidate record under. */
  sealedOperationKey: string;
  revisionId: string;
  sourceFingerprint: string;
  maintenanceId: string | null;
  coordinatorMode: "ensure-running" | "require-running";
  preview?: unknown;
  rowVersions?: unknown[];
}
/** Whether the job carries a candidate whose apply has not concluded. */
export function hasOpenCandidate(protocol: AdminJobProtocol | undefined): boolean {
  return protocol?.candidate !== undefined && protocol.candidate.phase !== "generation_applied";
}
/** SQL twin of `hasOpenCandidate`. */
export function openCandidateCondition() {
  return sql`(${adminJob.protocol}->'candidate' IS NOT NULL AND coalesce(${adminJob.protocol}->'candidate'->>'phase','') <> 'generation_applied')`;
}
/** Writes the job's candidate (or removes it) under the job's claim. */
export async function writeAdminJobCandidate(
  connection: Pick<typeof db, "update">,
  id: string,
  execution: JobExecution | undefined,
  candidate: AdminJobCandidate | null,
  statuses = ["running", "cancel_pending"],
): Promise<AdminJobProtocol> {
  const [row] = await connection
    .update(adminJob)
    .set({
      protocol: candidate
        ? sql`${adminJob.protocol} || jsonb_build_object('candidate', ${JSON.stringify(candidate)}::jsonb)`
        : sql`${adminJob.protocol} - 'candidate'`,
    })
    .where(jobOwnership(id, execution, statuses))
    .returning({ protocol: adminJob.protocol });
  if (!row) throw new JobOwnershipLost();
  return row.protocol as AdminJobProtocol;
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
  const own = { ...(result as Record<string, unknown> | null), ...protocol?.handler };
  const data = own._dataExecutions as unknown;
  const standalone = own as { _standalone?: unknown; _standaloneSettled?: unknown };
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
  const own = sql`${adminJob.protocol}->'handler'`;
  return sql`(${own}->'_standalone' IS NULL OR ${own}->'_standaloneSettled' = 'true'::jsonb) AND NOT (coalesce(${adminJob.protocol}->'operations'->>'version','') = '3' AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(${adminJob.protocol}->'operations'->'operations','{}'::jsonb)) AS active_entry WHERE coalesce(active_entry.value->>'terminal','false') <> 'true')) AND CASE WHEN ${own}->'_dataExecutions' IS NULL THEN true WHEN jsonb_typeof(${own}->'_dataExecutions') <> 'array' THEN false ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${own}->'_dataExecutions') AS backend_entry WHERE backend_entry->>'state' IS DISTINCT FROM 'terminal' OR coalesce(backend_entry->>'publication','unknown') NOT IN ('not_started','committed') OR coalesce(backend_entry->>'status','') NOT IN ('ok','partial','error','canceled','interrupted') OR coalesce(backend_entry->>'id','') !~ '^[a-f0-9-]{36}$' OR coalesce(backend_entry->>'operationKey','') !~ '^opk1_[A-Za-z0-9_-]{16,64}$' OR coalesce(backend_entry->>'fingerprint','') !~ '^[a-f0-9]{64}$') END`;
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

export interface OwnedJobLogLine {
  jobId: string;
  stream: "stdout" | "stderr";
  line: string;
  createdAt: Date;
  /** The agent event a relayed line came from; a repeated id is not written again. */
  sourceEventId?: string;
}
/**
 * Writes one line to a job's log. The job row's lock serializes the insert
 * with claims, cancellation, settlement and the job's other lines: the line
 * takes the next `seq` from the job's counters, which it advances in the same
 * statement. Once a job records agent operations it accepts lines only within
 * its log capacity, which counts all its lines, including earlier local ones.
 * Only a repeated source event is skipped; a `seq` collision raises, since it
 * means the counter no longer matches the log. The returned insertion, not a
 * preflight SELECT, is the event publication authority: `null` means the line
 * was not written.
 */
export async function insertOwnedJobLog(
  execution: JobExecution | undefined,
  entry: OwnedJobLogLine,
): Promise<{ seq: number } | null> {
  const bytes = Buffer.byteLength(entry.line, "utf8");
  const [result] = await db.execute<{ owned: boolean; seq: number | null }>(sql`
    WITH owner AS MATERIALIZED (
      SELECT ${adminJob.id}, ${adminJob.logEvents}, ${adminJob.logBytes}, ${adminJob.protocol} FROM ${adminJob} WHERE ${jobOwnership(entry.jobId, execution)} FOR UPDATE
    ), inserted AS (
      INSERT INTO ${adminJobLog} (job_id, seq, stream, line, source_event_id, created_at)
      SELECT owner.id, owner.log_events, ${entry.stream}, ${entry.line}, ${entry.sourceEventId ?? null}, ${entry.createdAt.toISOString()}::timestamptz
      FROM owner WHERE coalesce(owner.protocol->'operations'->>'version','') <> '3' OR (
        owner.log_events < ${ADMIN_JOB_LOG_LIMITS.events}
        AND owner.log_bytes + ${bytes} <= ${ADMIN_JOB_LOG_LIMITS.bytes}
      ) ON CONFLICT (job_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
      RETURNING job_id, seq
    ), charged AS (
      UPDATE ${adminJob} SET log_events = owner.log_events + 1, log_bytes = owner.log_bytes + ${bytes}
      FROM owner, inserted WHERE ${adminJob.id} = owner.id AND inserted.job_id = owner.id
      RETURNING ${adminJob.id}
    )
    SELECT EXISTS (SELECT 1 FROM owner) AS owned, (SELECT seq FROM inserted) AS seq
  `);
  if (!result?.owned) throw new JobOwnershipLost();
  return result.seq === null ? null : { seq: Number(result.seq) };
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
