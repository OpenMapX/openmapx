import {
  dataExecutionIdentitySchema,
  dataExecutionInputSchema,
} from "@openmapx/core/data-manager-contracts";
import {
  createDataManagerTransport,
  requestDataExecutionCancellation,
} from "@openmapx/core/data-manager-sdk";
import {
  ACTIVE_JOB_STATUSES,
  type DataJobStatus,
  type DataJobTrigger,
  type JobStatus,
} from "@openmapx/core/jobs";
import { envString } from "@openmapx/core/server-env";
import { readDataManagerToken } from "@openmapx/core/service-secret-files";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db } from "../db";
import { adminJob, adminJobLog, dataManagerJob, dataManagerJobStage } from "../db/schema";
import { type ActorSummary, resolveActors } from "../utils/resolve-actor";
import { publicAdminJobPayload } from "./admin-job-failure";

export type ActivityJobSource = "application" | "data-manager";
export type ActivityJobFilter = "active" | "completed" | "failed";

export interface ActivityJob {
  source: ActivityJobSource;
  id: string;
  type: string;
  status: string;
  payload: unknown;
  error: string | null;
  progress: number | null;
  createdBy: string | null;
  actorLabel: string;
  actor: ActorSummary | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelable: boolean;
}

interface ActivityJobRow {
  source: ActivityJobSource;
  id: string;
  type: string;
  status: string;
  payload: unknown;
  error: string | null;
  progress: number | null;
  createdBy: string | null;
  trigger: DataJobTrigger | null;
  triggeredByUserId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelable: boolean;
}

const APPLICATION_STATUSES: Record<ActivityJobFilter, JobStatus[]> = {
  active: [...ACTIVE_JOB_STATUSES],
  completed: ["succeeded", "cancelled"],
  failed: ["failed"],
};

const DATA_MANAGER_STATUSES: Record<ActivityJobFilter, DataJobStatus[]> = {
  active: [...ACTIVE_JOB_STATUSES],
  completed: ["succeeded", "partially_succeeded", "cancelled"],
  failed: ["failed"],
};

/** Who started a data job, as the Activity list names it. */
export function dataManagerActor(
  trigger: DataJobTrigger,
  triggeredByUserId: string | null,
): { userId: string | null; label: string } {
  switch (trigger) {
    case "api":
      return triggeredByUserId
        ? { userId: triggeredByUserId, label: "Administrator" }
        : { userId: null, label: "API" };
    case "agent":
      return { userId: null, label: "Operations agent" };
    case "cli":
      return { userId: null, label: "Host CLI" };
    case "cron":
      return { userId: null, label: "Scheduled" };
    case "bootstrap":
      return { userId: null, label: "Bootstrap" };
  }
}

function applicationWhere(filter?: ActivityJobFilter) {
  return filter ? inArray(adminJob.status, APPLICATION_STATUSES[filter]) : undefined;
}

function dataManagerWhere(filter?: ActivityJobFilter) {
  if (!filter) return undefined;
  const ordinary = inArray(dataManagerJob.status, DATA_MANAGER_STATUSES[filter]);
  return filter === "active" ? or(ordinary, dataManagerRecoveryPending()) : ordinary;
}
function dataManagerRecoveryPending() {
  return sql<boolean>`coalesce(${dataManagerJob.status}='interrupted' AND ${dataManagerJob.finishedAt} IS NULL AND ${dataManagerJob.executionState}->>'publication'='unknown',false)`;
}
function currentDataManagerMutation(job: {
  status: string;
  finishedAt: Date | null;
  executionState: unknown;
}) {
  return (
    ["queued", "running", "cancel_pending"].includes(job.status) ||
    (job.status === "interrupted" &&
      job.finishedAt === null &&
      typeof job.executionState === "object" &&
      job.executionState !== null &&
      "publication" in job.executionState &&
      job.executionState.publication === "unknown")
  );
}

function applicationSelect(filter?: ActivityJobFilter) {
  return db
    .select({
      source: sql<ActivityJobSource>`'application'::text`.as("source"),
      id: adminJob.id,
      type: sql<string>`${adminJob.type}`.as("type"),
      status: sql<string>`${adminJob.status}`.as("status"),
      payload: adminJob.payload,
      error: adminJob.error,
      progress: adminJob.progress,
      createdBy: adminJob.createdByUserId,
      trigger: sql<DataJobTrigger | null>`null::text`.as("trigger"),
      triggeredByUserId: sql<string | null>`null::text`.as("triggered_by_user_id"),
      createdAt: adminJob.createdAt,
      startedAt: adminJob.startedAt,
      finishedAt: adminJob.finishedAt,
      cancelable: sql<boolean>`true`.as("cancelable"),
    })
    .from(adminJob)
    .where(applicationWhere(filter));
}

function dataManagerSelect(filter?: ActivityJobFilter) {
  return db
    .select({
      source: sql<ActivityJobSource>`'data-manager'::text`.as("source"),
      id: dataManagerJob.id,
      type: dataManagerJob.kind,
      status: sql<string>`${dataManagerJob.status}`.as("status"),
      payload: sql<unknown>`${dataManagerJob.executionInput}`.as("payload"),
      error: sql<string | null>`null::text`.as("error"),
      progress: sql<number | null>`null::integer`.as("progress"),
      createdBy: sql<string | null>`null::text`.as("created_by"),
      trigger: sql<DataJobTrigger | null>`${dataManagerJob.trigger}`.as("trigger"),
      triggeredByUserId: sql<string | null>`${dataManagerJob.triggeredByUserId}`.as(
        "triggered_by_user_id",
      ),
      createdAt: dataManagerJob.admittedAt,
      startedAt: dataManagerJob.admittedAt,
      finishedAt: dataManagerJob.finishedAt,
      cancelable:
        sql<boolean>`(${dataManagerJob.status} IN ('queued','running','cancel_pending') OR ${dataManagerRecoveryPending()})`.as(
          "cancelable",
        ),
    })
    .from(dataManagerJob)
    .where(dataManagerWhere(filter));
}

export async function listActivityJobs(options: {
  filter?: ActivityJobFilter;
  limit: number;
  offset: number;
}): Promise<{ jobs: ActivityJob[]; total: number }> {
  const limit = Math.min(Math.max(options.limit, 1), 200);
  const offset = Math.max(options.offset, 0);
  const appQuery = applicationSelect(options.filter);
  const dataManagerQuery = dataManagerSelect(options.filter);

  const [rows, [applicationCount], [dataManagerCount]] = await Promise.all([
    unionAll(appQuery, dataManagerQuery)
      .orderBy((fields) => desc(fields.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(adminJob).where(applicationWhere(options.filter)),
    db.select({ total: count() }).from(dataManagerJob).where(dataManagerWhere(options.filter)),
  ]);

  const typedRows = rows as ActivityJobRow[];
  const actorOf = (row: ActivityJobRow) =>
    row.source === "data-manager" && row.trigger
      ? dataManagerActor(row.trigger, row.triggeredByUserId)
      : { userId: row.createdBy, label: "System" };
  const actors = await resolveActors(typedRows.map((row) => actorOf(row).userId));

  return {
    jobs: typedRows.map((row) => {
      const parsedActor = actorOf(row);
      const createdBy = parsedActor.userId;
      return {
        source: row.source,
        id: row.id,
        type: row.type,
        status: row.status,
        payload: publicAdminJobPayload(row.type, row.payload),
        error: row.error,
        progress: row.progress,
        createdBy,
        actorLabel: parsedActor.label,
        actor: createdBy ? (actors.get(createdBy) ?? null) : null,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        cancelable: row.cancelable,
      };
    }),
    total: (applicationCount?.total ?? 0) + (dataManagerCount?.total ?? 0),
  };
}

export async function getActivityJob(id: string, source: ActivityJobSource) {
  if (source === "application") {
    const [row] = await db.select().from(adminJob).where(eq(adminJob.id, id)).limit(1);
    if (!row) return null;
    // The runner's protocol state and log accounting never leave the API.
    const {
      protocol: _protocol,
      logEvents: _events,
      logBytes: _bytes,
      createdByUserId: createdBy,
      ...job
    } = row;
    const logs = await db
      .select({
        jobId: adminJobLog.jobId,
        seq: adminJobLog.seq,
        stream: adminJobLog.stream,
        line: adminJobLog.line,
        createdAt: adminJobLog.createdAt,
      })
      .from(adminJobLog)
      .where(eq(adminJobLog.jobId, id))
      .orderBy(adminJobLog.seq);
    return {
      ...job,
      createdBy,
      result: job.result,
      payload: publicAdminJobPayload(job.type, job.payload),
      source,
      actorLabel: createdBy ? "Administrator" : "System",
      cancelable: job.status === "queued" || job.status === "running",
      logs,
      stages: [],
    };
  }

  const [job] = await db.select().from(dataManagerJob).where(eq(dataManagerJob.id, id)).limit(1);
  if (!job) return null;
  const stages = await db
    .select()
    .from(dataManagerJobStage)
    .where(eq(dataManagerJobStage.jobId, id))
    .orderBy(dataManagerJobStage.startedAt);
  const actor = dataManagerActor(job.trigger, job.triggeredByUserId);
  return {
    source,
    id: String(job.id),
    type: job.kind,
    status: job.status,
    payload: job.executionInput,
    result: null,
    error: null,
    progress: null,
    createdBy: actor.userId,
    actorLabel: actor.label,
    createdAt: job.admittedAt,
    startedAt: job.admittedAt,
    finishedAt: job.finishedAt,
    cancelable:
      currentDataManagerMutation(job) &&
      dataExecutionInputSchema.safeParse(job.executionInput).success,
    logs: [],
    stages,
  };
}

/** Load the receiver-owned immutable tuple; browser parameters select only the
 * visible job. The receiver persists cancellation before signaling its worker. */
export async function cancelDataManagerActivityJob(id: string): Promise<boolean> {
  const [job] = await db.select().from(dataManagerJob).where(eq(dataManagerJob.id, id)).limit(1);
  if (
    !job ||
    !currentDataManagerMutation(job) ||
    !dataExecutionInputSchema.safeParse(job.executionInput).success
  )
    return false;
  const identity = dataExecutionIdentitySchema.parse({
    id: String(job.id),
    operationKey: job.operationKey,
    fingerprint: job.executionFingerprint,
  });
  await requestDataExecutionCancellation(identity, {
    transport: createDataManagerTransport({
      baseUrl: envString("DATA_MANAGER_URL", "http://localhost:4000"),
      authToken: readDataManagerToken(),
      requestTimeoutMs: 15000,
    }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}
