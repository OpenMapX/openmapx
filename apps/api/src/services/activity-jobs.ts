import {
  dataExecutionIdentitySchema,
  dataExecutionInputSchema,
} from "@openmapx/core/data-manager-contracts";
import {
  createDataManagerTransport,
  requestDataExecutionCancellation,
} from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db } from "../db";
import { adminJob, adminJobLog, dataManagerJobStages, dataManagerJobs } from "../db/schema";
import { type ActorSummary, resolveActors } from "../utils/resolve-actor";
import { publicAdminJobResult } from "./admin-job-failure";

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
  triggeredBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelable: boolean;
}

const APPLICATION_STATUSES: Record<ActivityJobFilter, string[]> = {
  active: ["queued", "running", "cancel_pending"],
  completed: ["success", "canceled"],
  failed: ["failed"],
};

const DATA_MANAGER_STATUSES: Record<ActivityJobFilter, string[]> = {
  active: ["queued", "running", "cancel_pending"],
  completed: ["ok", "partial", "canceled"],
  failed: ["error", "interrupted"],
};

export function normalizeDataManagerJobStatus(status: string): string {
  if (status === "ok") return "success";
  if (status === "error") return "failed";
  return status;
}

export function parseDataManagerActor(triggeredBy: string | null): {
  userId: string | null;
  label: string;
} {
  if (!triggeredBy) return { userId: null, label: "System" };

  for (const prefix of ["api:user:", "manual:admin:", "manual:user:"]) {
    if (triggeredBy.startsWith(prefix)) {
      return { userId: triggeredBy.slice(prefix.length) || null, label: "Administrator" };
    }
  }

  if (triggeredBy === "cron" || triggeredBy.includes("data-manager-cron")) {
    return { userId: null, label: "Scheduled" };
  }
  if (triggeredBy === "bootstrap") return { userId: null, label: "Bootstrap" };
  if (triggeredBy === "data-manager-auto-bump") {
    return { userId: null, label: "Automatic version bump" };
  }

  return {
    userId: null,
    label: triggeredBy
      .replace(/^api:/, "")
      .replace(/^manual:/, "")
      .replace(/[-_:]+/g, " "),
  };
}

function applicationWhere(filter?: ActivityJobFilter) {
  return filter ? inArray(adminJob.status, APPLICATION_STATUSES[filter]) : undefined;
}

function dataManagerWhere(filter?: ActivityJobFilter) {
  if (!filter) return undefined;
  const ordinary = inArray(dataManagerJobs.status, DATA_MANAGER_STATUSES[filter]);
  return filter === "active"
    ? or(ordinary, dataManagerRecoveryPending())
    : filter === "failed"
      ? and(ordinary, sql`NOT (${dataManagerRecoveryPending()})`)
      : ordinary;
}
function dataManagerRecoveryPending() {
  return sql<boolean>`coalesce(${dataManagerJobs.executionVersion}=2 AND ${dataManagerJobs.status}='interrupted' AND ${dataManagerJobs.finishedAt} IS NULL AND ${dataManagerJobs.executionState}->>'publication'='unknown',false)`;
}
function currentDataManagerMutation(job: {
  executionVersion: number | null;
  status: string;
  finishedAt: Date | null;
  executionState: unknown;
}) {
  return (
    job.executionVersion === 2 &&
    (["queued", "running", "cancel_pending"].includes(job.status) ||
      (job.status === "interrupted" &&
        job.finishedAt === null &&
        typeof job.executionState === "object" &&
        job.executionState !== null &&
        "publication" in job.executionState &&
        job.executionState.publication === "unknown"))
  );
}

function applicationSelect(filter?: ActivityJobFilter) {
  return db
    .select({
      source: sql<ActivityJobSource>`'application'::text`.as("source"),
      id: adminJob.id,
      type: adminJob.type,
      status: adminJob.status,
      payload: adminJob.payload,
      error: adminJob.error,
      progress: adminJob.progress,
      createdBy: adminJob.createdBy,
      triggeredBy: sql<string | null>`null::text`.as("triggered_by"),
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
      id: sql<string>`${dataManagerJobs.id}::text`.as("id"),
      type: dataManagerJobs.kind,
      status: sql<string>`case
        when ${dataManagerJobs.status} = 'ok' then 'success'
        when ${dataManagerJobs.status} = 'error' then 'failed'
        else ${dataManagerJobs.status}
      end`.as("status"),
      payload:
        sql<unknown>`CASE WHEN ${dataManagerJobs.executionVersion}=2 THEN ${dataManagerJobs.executionInput} ELSE ${dataManagerJobs.metadata} END`.as(
          "payload",
        ),
      error: sql<string | null>`null::text`.as("error"),
      progress: sql<number | null>`null::integer`.as("progress"),
      createdBy: sql<string | null>`null::text`.as("created_by"),
      triggeredBy: dataManagerJobs.triggeredBy,
      createdAt: dataManagerJobs.startedAt,
      startedAt: dataManagerJobs.startedAt,
      finishedAt: dataManagerJobs.finishedAt,
      cancelable:
        sql<boolean>`${dataManagerJobs.executionVersion}=2 AND (${dataManagerJobs.status} IN ('queued','running','cancel_pending') OR ${dataManagerRecoveryPending()}) AND ${dataManagerJobs.kind} IN ('download-osm','download-fonts','convert-overpass','transit-sync','overture-pull','overture-ingest','overture-extract','overture-conflate','overture-sync','search-index-build','notable-places-build','generation-hardlinks','transit-maintenance','catalog.validate','catalog.activate') AND ${dataManagerJobs.operationKey} IS NOT NULL AND ${dataManagerJobs.executionFingerprint} IS NOT NULL`.as(
          "cancelable",
        ),
    })
    .from(dataManagerJobs)
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
    db.select({ total: count() }).from(dataManagerJobs).where(dataManagerWhere(options.filter)),
  ]);

  const typedRows = rows as ActivityJobRow[];
  const actorIds = typedRows.map((row) =>
    row.source === "application" ? row.createdBy : parseDataManagerActor(row.triggeredBy).userId,
  );
  const actors = await resolveActors(actorIds);

  return {
    jobs: typedRows.map((row) => {
      const parsedActor =
        row.source === "data-manager"
          ? parseDataManagerActor(row.triggeredBy)
          : { userId: row.createdBy, label: "System" };
      const createdBy = parsedActor.userId;
      return {
        source: row.source,
        id: row.id,
        type: row.type,
        status: row.status,
        payload: row.payload,
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
    const [job] = await db.select().from(adminJob).where(eq(adminJob.id, id)).limit(1);
    if (!job) return null;
    const logs = await db
      .select()
      .from(adminJobLog)
      .where(eq(adminJobLog.jobId, id))
      .orderBy(adminJobLog.seq);
    return {
      ...job,
      result: publicAdminJobResult(job.result),
      source,
      actorLabel: job.createdBy ? "Administrator" : "System",
      cancelable: job.status === "queued" || job.status === "running",
      logs,
      stages: [],
    };
  }

  const [job] = await db.select().from(dataManagerJobs).where(eq(dataManagerJobs.id, id)).limit(1);
  if (!job) return null;
  const stages = await db
    .select()
    .from(dataManagerJobStages)
    .where(eq(dataManagerJobStages.jobId, id))
    .orderBy(dataManagerJobStages.startedAt);
  const actor = parseDataManagerActor(job.triggeredBy);
  return {
    source,
    id: String(job.id),
    type: job.kind,
    status: normalizeDataManagerJobStatus(job.status),
    payload: job.executionVersion === 2 ? job.executionInput : job.metadata,
    result: null,
    error: null,
    progress: null,
    createdBy: actor.userId,
    actorLabel: actor.label,
    createdAt: job.startedAt,
    startedAt: job.startedAt,
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
  const [job] = await db.select().from(dataManagerJobs).where(eq(dataManagerJobs.id, id)).limit(1);
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
      authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
      requestTimeoutMs: 15000,
    }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}
