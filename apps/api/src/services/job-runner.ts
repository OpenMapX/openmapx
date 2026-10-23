import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { dbActorId } from "../utils/actor";
import { AdminJobFailure, JobObservationPending, publicAdminJobResult } from "./admin-job-failure";
import { cancelAdminJobOperations, resumeAdminJobObservation } from "./admin-job-ops";
import {
  adminJobObservationDue,
  claimAdminJob,
  insertOwnedJobLog,
  type JobExecution,
  JobOwnershipLost,
  jobOwnership,
  readJobExecution,
  renewAdminJobClaim,
} from "./admin-job-state";
import { type JobStatusEvent, jobEventBus, TERMINAL_JOB_STATUSES } from "./job-events";
import { ApiOpsError, OpsObservationPending } from "./ops-client";
import { appApiRestartCheckpoint } from "./system-update-state";

type AppApiReplacementOutcome = "applied" | "rolled-back" | "failed";
interface AppApiRuntimeInfo {
  containerId: string;
  imageId: string;
  updateJobId: string | null;
}

export interface JobContext {
  jobId: string;
  jobType?: string;
  execution?: JobExecution;
  observationOnly?: boolean;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  log(
    line: string,
    stream?: "stdout" | "stderr",
    sourceEventId?: string,
    sourceSeq?: number,
  ): Promise<void>;
  setProgress(progress: number): Promise<void>;
  /** Persist restart-safe state before an operation intentionally replaces app-api. */
  checkpoint(
    result: Record<string, unknown>,
    progress?: number,
    admissionKey?: string,
  ): Promise<void>;
  /** Last durable checkpoint loaded with the job and updated after each checkpoint. */
  checkpointResult?: Record<string, unknown> | null;
}

type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | undefined>;

export const AGENT_RECOVERABLE_ADMIN_JOB_TYPES = [
  "backup.operation",
  "data.operation",
  "service.bulk",
  "service.start",
  "service.stop",
  "service.restart",
  "service.apply",
  "compose.render",
  "system.diagnostics",
  "system.update",
] as const;

class JobPersistenceUnavailable extends Error {}

class AdminJobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Map<string, AbortController>();
  private readonly logSeq = new Map<string, number>();
  readonly maxConcurrent = 2;

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    createdBy?: string | null,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(adminJob).values({
      id,
      type,
      status: "queued",
      payload,
      // Synthetic (loopback) actors have no user row → store null, not a FK violation.
      createdBy: dbActorId(createdBy),
    });
    setTimeout(() => void this.pump(), 0);
    return id;
  }

  /** Publish a status transition so live viewers see it without polling. */
  private announce(
    jobId: string,
    status: string,
    patch: Omit<JobStatusEvent, "type" | "status"> = {},
  ): void {
    jobEventBus.publish(jobId, { type: "status", status, ...patch });
    if (TERMINAL_JOB_STATUSES.has(status)) jobEventBus.markTerminal(jobId);
  }

  async cancel(jobId: string): Promise<boolean> {
    const canceledAt = new Date();
    const queued = await db
      .update(adminJob)
      .set({ status: "canceled", finishedAt: canceledAt })
      .where(and(eq(adminJob.id, jobId), eq(adminJob.status, "queued")))
      .returning({ id: adminJob.id });
    if (queued.length > 0) {
      this.announce(jobId, "canceled", { finishedAt: canceledAt.toISOString() });
      return true;
    }

    const [job] = await db
      .update(adminJob)
      .set({
        status: "cancel_pending",
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('_cancelRequestedAt', coalesce(${adminJob.result}->>'_cancelRequestedAt', ${new Date().toISOString()}::text))`,
      })
      .where(and(eq(adminJob.id, jobId), inArray(adminJob.status, ["running", "cancel_pending"])))
      .returning();
    if (!job) return false;
    this.announce(jobId, "cancel_pending");
    // Stops only this observer/forward handler. Backend containment is independently verified.
    this.active.get(jobId)?.abort();
    let outcome: Awaited<ReturnType<typeof cancelAdminJobOperations>> = "pending";
    try {
      outcome = await cancelAdminJobOperations(job.result, undefined, {
        jobId,
        onEvidence: async (evidence) => {
          await db
            .update(adminJob)
            .set({
              result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`,
            })
            .where(jobOwnership(jobId, readJobExecution(job.result), ["cancel_pending"]));
        },
      });
    } catch {
      /* Retain intent. */
    }
    if (outcome !== "canceled") return false;
    const finishedAt = new Date();
    const rows = await db
      .update(adminJob)
      .set({
        status: "canceled",
        finishedAt,
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) - 'observation'`,
      })
      .where(jobOwnership(jobId, readJobExecution(job.result), ["cancel_pending"]))
      .returning({ id: adminJob.id, result: adminJob.result });
    if (rows.length === 0) return false;
    this.announce(jobId, "canceled", {
      finishedAt: finishedAt.toISOString(),
      result: publicAdminJobResult(rows[0]?.result as Record<string, unknown> | null),
    });
    return true;
  }

  async findActive(type: string): Promise<{ id: string; status: string } | null> {
    const [job] = await db
      .select({ id: adminJob.id, status: adminJob.status })
      .from(adminJob)
      .where(
        and(
          eq(adminJob.type, type),
          inArray(adminJob.status, ["queued", "running", "cancel_pending"]),
        ),
      )
      .orderBy(asc(adminJob.createdAt))
      .limit(1);
    return job ?? null;
  }

  async initialize(
    options: {
      completeRestartedUpdates?: boolean;
      currentAppApiRuntime?: AppApiRuntimeInfo | null;
      resolveReplacementOutcome?: (outcomeFile: string) => Promise<AppApiReplacementOutcome | null>;
      cleanupReplacementOutcome?: (outcomeFile: string) => Promise<void>;
    } = {},
  ): Promise<void> {
    // An application update deliberately replaces app-api as its final step.
    // The server calls this only after it is listening. Finalize only jobs that
    // wrote the explicit pre-restart checkpoint, passed the migration gate,
    // and are now running the exact image that the update pulled. Any other
    // interrupted job retains uncertainty until its original effect is observed.
    const interruptedUpdates = await db
      .select({ id: adminJob.id, result: adminJob.result, status: adminJob.status })
      .from(adminJob)
      .where(and(eq(adminJob.status, "running"), eq(adminJob.type, "system.update")));
    const checkpointedUpdates = interruptedUpdates.flatMap((job) => {
      const checkpoint = appApiRestartCheckpoint(job.result);
      return checkpoint ? [{ ...job, checkpoint }] : [];
    });
    for (const candidate of checkpointedUpdates) {
      const claimed = await claimAdminJob({ ...candidate, status: candidate.status ?? "running" });
      if (!claimed) continue;
      const execution = readJobExecution(claimed.result);
      const outcome = await (options.resolveReplacementOutcome ?? (async () => null))(
        candidate.checkpoint.outcomeFile,
      );
      const runtime = options.currentAppApiRuntime;
      const migrationsFailed = options.completeRestartedUpdates === false;
      if (!migrationsFailed && (outcome === null || (outcome === "applied" && !runtime))) continue;
      const complete =
        !migrationsFailed &&
        outcome === "applied" &&
        runtime?.imageId === candidate.checkpoint.expectedImageId &&
        runtime.containerId !== candidate.checkpoint.previousContainerId &&
        runtime.updateJobId === candidate.id;
      const error = migrationsFailed
        ? "Update replaced app-api, but database migrations did not complete"
        : outcome === "rolled-back"
          ? "Update failed; the previous app-api image was restored"
          : outcome === "failed"
            ? "Update failed and app-api rollback did not complete"
            : "Update restarted app-api with an unexpected container identity or image";
      const rows = await db
        .update(adminJob)
        .set({
          status: complete ? "success" : "failed",
          finishedAt: new Date(),
          ...(complete
            ? {
                progress: 100,
                result: {
                  ...(claimed.result as Record<string, unknown>),
                  phase: "complete",
                  completedAfterRestart: true,
                },
              }
            : { error }),
        })
        .where(jobOwnership(candidate.id, execution))
        .returning({ id: adminJob.id });
      if (rows.length) await options.cleanupReplacementOutcome?.(candidate.checkpoint.outcomeFile);
    }

    // Startup marks interrupted observers due; no handler is requeued/replayed.
    await db
      .update(adminJob)
      .set({
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('observation', jsonb_build_object('state', 'unknown', 'reason', 'transport', 'nextCheckAt', ${new Date().toISOString()}::text))`,
      })
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          inArray(adminJob.type, [...AGENT_RECOVERABLE_ADMIN_JOB_TYPES]),
        ),
      );

    // Unknown handlers are never replayed. Interruption alone proves neither
    // failure nor containment, so retain their evidence for operator recovery.
    await db
      .update(adminJob)
      .set({
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('observation', jsonb_build_object('state', 'unknown', 'reason', 'recovery_required', 'nextCheckAt', ${new Date().toISOString()}::text))`,
      })
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          sql`${adminJob.result}->'observation' IS NULL`,
        ),
      );
    void this.pump();
  }

  private pumping = false;
  private pumpAgain = false;

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (this.active.size < this.maxConcurrent) {
          const [candidate] = await db
            .select()
            .from(adminJob)
            .where(eq(adminJob.status, "queued"))
            .orderBy(asc(adminJob.createdAt))
            .limit(1);
          if (!candidate) break;
          const job = await claimAdminJob(candidate, { status: "running", startedAt: new Date() });
          if (!job) continue;
          void this.launchJob(job);
        }
      } while (this.pumpAgain && this.active.size < this.maxConcurrent);
    } finally {
      this.pumping = false;
    }
  }

  private launchJob(
    job: typeof adminJob.$inferSelect,
    observe = false,
    observationSignal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.logSeq.set(job.id, 0);

    let closed = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      if (closed || controller.signal.aborted) return;
      try {
        await renewAdminJobClaim(job.id, readJobExecution(job.result));
      } catch (error) {
        controller.abort(error);
        return;
      }
      if (!closed) {
        heartbeat = setTimeout(() => void renew(), 10_000);
        heartbeat.unref?.();
      }
    };
    if (!observe) {
      heartbeat = setTimeout(() => void renew(), 10_000);
      heartbeat.unref?.();
    }
    return this.executeJob(
      job.id,
      job.type,
      (job.payload as Record<string, unknown>) ?? {},
      (job.result as Record<string, unknown> | null) ?? null,
      observe
        ? AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(3_000),
            ...(observationSignal ? [observationSignal] : []),
          ])
        : controller.signal,
      observe,
    )
      .finally(() => {
        closed = true;
        clearTimeout(heartbeat);
        this.active.delete(job.id);
        this.logSeq.delete(job.id);
        setTimeout(() => void this.pump(), 0);
      })
      .catch((err) => {
        console.error(
          `[job-runner] Unexpected error finalizing job ${job.id}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

  private async executeJob(
    jobId: string,
    type: string,
    payload: Record<string, unknown>,
    checkpointResult: Record<string, unknown> | null,
    signal: AbortSignal,
    observe = false,
  ): Promise<void> {
    const retirement = new AbortController();
    signal = AbortSignal.any([signal, retirement.signal]);
    const lost = (): never => {
      const error = new JobOwnershipLost();
      retirement.abort(error);
      throw error;
    };
    const handler = observe ? resumeAdminJobObservation : this.handlers.get(type);
    const execution = readJobExecution(checkpointResult);
    let checkpointTail = Promise.resolve();
    const ctx: JobContext = {
      jobId,
      jobType: type,
      execution,
      observationOnly: observe,
      payload,
      signal,
      checkpointResult,
      log: async (line, stream = "stdout", sourceEventId, sourceSeq) => {
        const localSeq = this.logSeq.get(jobId) ?? 0;
        const seq = sourceSeq ?? localSeq;
        this.logSeq.set(jobId, Math.max(localSeq + 1, seq + 1));
        const id = sourceEventId ?? randomUUID();
        const createdAt = new Date();
        signal.throwIfAborted();
        let inserted: boolean;
        try {
          inserted = await insertOwnedJobLog(execution, {
            id,
            jobId,
            seq,
            stream,
            line,
            createdAt,
          });
        } catch (error) {
          if (error instanceof JobOwnershipLost) lost();
          throw error;
        }
        signal.throwIfAborted();
        if (!inserted) return;
        jobEventBus.publish(jobId, {
          type: "log",
          id,
          seq,
          stream,
          line,
          createdAt: createdAt.toISOString(),
        });
      },
      setProgress: async (progress) => {
        signal.throwIfAborted();
        const rows = await db
          .update(adminJob)
          .set({ progress })
          .where(jobOwnership(jobId, execution))
          .returning({ id: adminJob.id })
          .catch(() => {
            throw new JobPersistenceUnavailable("Administrative job progress unavailable");
          });
        if (!rows.length) lost();
        jobEventBus.publish(jobId, { type: "progress", progress });
      },
      checkpoint: async (result, progress, admissionKey) => {
        const write = checkpointTail.then(async () => {
          signal.throwIfAborted();
          // A handler cannot replace the runner's ownership member.
          const merged: Record<string, unknown> = {
            ...ctx.checkpointResult,
            ...result,
            ...(execution ? { _execution: execution } : {}),
          };
          const rows = await db
            .update(adminJob)
            .set({
              result: sql`${JSON.stringify(merged)}::jsonb || jsonb_build_object('_observationLeaseUntil', ${adminJob.result}->'_observationLeaseUntil')`,
              ...(progress === undefined ? {} : { progress }),
            })
            .where(
              and(
                jobOwnership(jobId, execution),
                ...(admissionKey
                  ? [
                      sql`${adminJob.result}->'opsProjection'->'operations'->${admissionKey} IS NULL`,
                      sql`(${adminJob.result}->'_parentExecution' IS NULL OR ${adminJob.result}->'_parentExecution' = ${JSON.stringify(merged._parentExecution ?? null)}::jsonb)`,
                    ]
                  : []),
              ),
            )
            .returning({ id: adminJob.id });
          if (!rows.length) lost();
          ctx.checkpointResult = merged;
          if (progress !== undefined) jobEventBus.publish(jobId, { type: "progress", progress });
        });
        checkpointTail = write.catch(() => undefined);
        return write.catch((error) => {
          if (error instanceof JobOwnershipLost || signal.aborted) throw error;
          throw new JobPersistenceUnavailable("Administrative job checkpoint unavailable");
        });
      },
    };

    if (!observe) this.announce(jobId, "running", { startedAt: new Date().toISOString() });
    const startedAtMs = Date.now();
    const pending = async (reason: OpsObservationPending["reason"]) => {
      try {
        const attempts = Math.min(12, Number(ctx.checkpointResult?._observationAttempts ?? 0) + 1);
        const observationPatch = {
          _observationAttempts: attempts,
          _observationLeaseUntil: null,
          observation: {
            state: "unknown",
            reason,
            nextCheckAt: new Date(
              Date.now() + Math.min(60_000, 5_000 * 2 ** (attempts - 1)),
            ).toISOString(),
          },
        };
        const rows = await db
          .update(adminJob)
          .set({
            result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(observationPatch)}::jsonb`,
          })
          .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]))
          .returning({ status: adminJob.status, result: adminJob.result });
        if (rows[0])
          this.announce(jobId, rows[0].status, {
            result: publicAdminJobResult(rows[0].result as Record<string, unknown> | null),
          });
      } catch {
        throw new JobPersistenceUnavailable("Administrative job persistence unavailable");
      }
    };
    const settle = async (
      status: "success" | "failed",
      result: Record<string, unknown> | null,
      error?: string,
    ) => {
      try {
        await checkpointTail;
        const merged: Record<string, unknown> = {
          ...ctx.checkpointResult,
          ...result,
          ...(execution ? { _execution: execution } : {}),
        };
        delete merged.observation;
        const finishedAt = new Date();
        const rows = await db
          .update(adminJob)
          .set({
            status,
            result: merged,
            error: error ?? null,
            finishedAt,
            ...(status === "success" ? { progress: 100 } : {}),
          })
          .where(jobOwnership(jobId, execution))
          .returning({ id: adminJob.id });
        if (rows.length) {
          this.announce(jobId, status, {
            result: publicAdminJobResult(merged),
            error: error ?? null,
            ...(status === "success" ? { progress: 100 } : {}),
            finishedAt: finishedAt.toISOString(),
          });
        } else {
          // Cancel intent wins; retain late evidence without publishing a terminal event.
          await db
            .update(adminJob)
            .set({
              result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _settled: { status, result: publicAdminJobResult(merged), error } })}::jsonb`,
            })
            .where(jobOwnership(jobId, execution, ["cancel_pending"]));
        }
      } catch {
        throw new JobPersistenceUnavailable("Administrative job persistence unavailable");
      }
    };
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!handler) throw new Error(`No handler registered for job type "${type}"`);
      if (observe) {
        const [current] = await db
          .select()
          .from(adminJob)
          .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]))
          .limit(1);
        if (!current) return;
        if (current.status === "cancel_pending") {
          const outcome = await cancelAdminJobOperations(current.result, undefined, {
            jobId,
            signal,
            onEvidence: async (evidence) => {
              ctx.checkpointResult = { ...ctx.checkpointResult, ...evidence };
              await db
                .update(adminJob)
                .set({
                  result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`,
                })
                .where(jobOwnership(jobId, execution, ["cancel_pending"]));
            },
          });
          if (outcome === "pending") {
            await pending("transport");
            return;
          }
          if (outcome === "canceled") {
            const finishedAt = new Date();
            const rows = await db
              .update(adminJob)
              .set({
                status: "canceled",
                finishedAt,
                result: sql`coalesce(${adminJob.result}, '{}'::jsonb) - 'observation'`,
              })
              .where(jobOwnership(jobId, execution, ["cancel_pending"]))
              .returning({ id: adminJob.id, result: adminJob.result });
            if (rows.length)
              this.announce(jobId, "canceled", {
                finishedAt: finishedAt.toISOString(),
                result: publicAdminJobResult(rows[0]?.result as Record<string, unknown> | null),
              });
            return;
          }
          // Containment was not performed. Observe the original outcome under this claim.
          const rows = await db
            .update(adminJob)
            .set({ status: "running" })
            .where(jobOwnership(jobId, execution, ["cancel_pending"]))
            .returning({ id: adminJob.id });
          if (!rows.length) return;
        }
      }
      const result = await handler(ctx);
      // A failed terminal write is uncertainty, not a handler failure. Never
      // turn an accepted successful effect into failed because PostgreSQL failed.
      try {
        await settle("success", result ?? null);
      } catch {
        await pending("transport");
      }
    } catch (err) {
      if (err instanceof JobOwnershipLost || err instanceof JobPersistenceUnavailable) return;
      if (err instanceof OpsObservationPending || err instanceof JobObservationPending)
        await pending(err.reason);
      else if (signal.aborted || (err instanceof Error && err.name === "AbortError"))
        await pending("observer_deadline");
      else if (observe && !(err instanceof AdminJobFailure) && !(err instanceof ApiOpsError))
        await pending("transport");
      else
        await settle(
          "failed",
          err instanceof AdminJobFailure
            ? err.result
            : err instanceof ApiOpsError
              ? (err.failureResult ?? null)
              : null,
          err instanceof Error ? err.message : "Administrative job failed",
        );
    } finally {
      jobEventBus.recordHandlerDuration(Date.now() - startedAtMs);
    }
  }

  /** Bounded, database-fenced acquisition; no arbitrary handler is dispatched. */
  async reconcile(options: { limit?: number } = {}, signal?: AbortSignal): Promise<void> {
    const limit = options.limit ?? 32;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Error("Invalid reconciliation limit");
    const due = await db
      .select()
      .from(adminJob)
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          inArray(adminJob.type, [...AGENT_RECOVERABLE_ADMIN_JOB_TYPES]),
          adminJobObservationDue(),
        ),
      )
      .orderBy(asc(adminJob.createdAt))
      .limit(limit);
    for (const job of due) {
      if (signal?.aborted) break;
      if (this.active.has(job.id)) continue;
      const claimed = await claimAdminJob(job, {}, true);
      if (claimed) await this.launchJob(claimed, true, signal);
    }
  }
}

export const jobRunner = new AdminJobRunner();
