import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../db";
import { adminJob, adminJobLog } from "../db/schema";
import { dbActorId } from "../utils/actor";
import {
  type AppApiReplacementOutcome,
  type AppApiRuntimeInfo,
  removeAppApiReplacementOutcome,
  waitForAppApiReplacementOutcome,
} from "./app-api-replacement";
import { appApiRestartCheckpoint } from "./system-update-state";

export interface JobContext {
  jobId: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  log(line: string, stream?: "stdout" | "stderr"): Promise<void>;
  setProgress(progress: number): Promise<void>;
  /** Persist restart-safe state before an operation intentionally replaces app-api. */
  checkpoint(result: Record<string, unknown>, progress?: number): Promise<void>;
}

type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | undefined>;

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

  async cancel(jobId: string): Promise<boolean> {
    const controller = this.active.get(jobId);
    if (controller) {
      controller.abort();
      return true;
    }
    const result = await db
      .update(adminJob)
      .set({ status: "canceled", finishedAt: new Date() })
      .where(and(eq(adminJob.id, jobId), eq(adminJob.status, "queued")))
      .returning({ id: adminJob.id });
    return result.length > 0;
  }

  async findActive(type: string): Promise<{ id: string; status: string } | null> {
    const [job] = await db
      .select({ id: adminJob.id, status: adminJob.status })
      .from(adminJob)
      .where(and(eq(adminJob.type, type), inArray(adminJob.status, ["queued", "running"])))
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
    // interrupted job remains a failure (including an update that died before
    // the checkpoint).
    const interruptedUpdates = await db
      .select({ id: adminJob.id, result: adminJob.result })
      .from(adminJob)
      .where(and(eq(adminJob.status, "running"), eq(adminJob.type, "system.update")));
    const checkpointedUpdates = interruptedUpdates.flatMap((job) => {
      const checkpoint = appApiRestartCheckpoint(job.result);
      return checkpoint ? [{ id: job.id, checkpoint }] : [];
    });
    const checkpointedUpdateIds = checkpointedUpdates.map((job) => job.id);
    const resolveOutcome = options.resolveReplacementOutcome ?? waitForAppApiReplacementOutcome;
    const evaluatedUpdates = await Promise.all(
      checkpointedUpdates.map(async (job) => ({
        ...job,
        outcome: await resolveOutcome(job.checkpoint.outcomeFile),
      })),
    );
    const runtime = options.currentAppApiRuntime;
    const cleanupOutcome = options.cleanupReplacementOutcome ?? removeAppApiReplacementOutcome;
    const completedUpdateIds =
      options.completeRestartedUpdates === false
        ? []
        : evaluatedUpdates
            .filter(
              (job) =>
                job.outcome === "applied" &&
                runtime?.imageId === job.checkpoint.expectedImageId &&
                runtime.containerId !== job.checkpoint.previousContainerId &&
                runtime.updateJobId === job.id,
            )
            .map((job) => job.id);
    if (completedUpdateIds.length > 0) {
      await db
        .update(adminJob)
        .set({
          status: "success",
          finishedAt: new Date(),
          progress: 100,
          result: { phase: "complete", completedAfterRestart: true },
        })
        .where(inArray(adminJob.id, completedUpdateIds));
      await Promise.all(
        evaluatedUpdates
          .filter((job) => completedUpdateIds.includes(job.id))
          .map((job) => cleanupOutcome(job.checkpoint.outcomeFile)),
      );
    }
    if (options.completeRestartedUpdates === false && checkpointedUpdateIds.length > 0) {
      await db
        .update(adminJob)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: "Update replaced app-api, but database migrations did not complete",
        })
        .where(inArray(adminJob.id, checkpointedUpdateIds));
      await Promise.all(evaluatedUpdates.map((job) => cleanupOutcome(job.checkpoint.outcomeFile)));
    }

    if (options.completeRestartedUpdates !== false) {
      const failedUpdates = evaluatedUpdates.filter((job) => !completedUpdateIds.includes(job.id));
      for (const job of failedUpdates) {
        const error =
          job.outcome === "rolled-back"
            ? "Update failed; the previous app-api image was restored"
            : job.outcome === "failed"
              ? "Update failed and app-api rollback did not complete"
              : job.outcome === null
                ? "Update helper did not report a durable outcome"
                : "Update restarted app-api with an unexpected container identity or image";
        await db
          .update(adminJob)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error,
          })
          .where(eq(adminJob.id, job.id));
        await cleanupOutcome(job.checkpoint.outcomeFile);
      }
    }

    // Mark every other job that was running when the api process died as failed.
    //
    // Earlier this re-queued them, but that turned a job that crashed
    // the api once into a crash loop: the job re-runs immediately on
    // startup, hits the same condition that killed the api before
    // (commonly `service.bulk` recreating postgis while the api was
    // logging to it), and dies again before clearing its own row.
    //
    // Failing the row instead is safe: the operator can re-trigger the
    // intent from the admin UI, and they'll see in the activity log that
    // the previous attempt was aborted by an api restart.
    await db
      .update(adminJob)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: "Job interrupted by api restart — re-run if still needed",
      })
      .where(
        checkpointedUpdateIds.length > 0
          ? and(eq(adminJob.status, "running"), notInArray(adminJob.id, checkpointedUpdateIds))
          : eq(adminJob.status, "running"),
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
          // Atomically claim a queued job by updating its status to running
          const [job] = await db
            .update(adminJob)
            .set({ status: "running", startedAt: new Date() })
            .where(
              and(
                eq(adminJob.status, "queued"),
                inArray(
                  adminJob.id,
                  db
                    .select({ id: adminJob.id })
                    .from(adminJob)
                    .where(eq(adminJob.status, "queued"))
                    .orderBy(asc(adminJob.createdAt))
                    .limit(1),
                ),
              ),
            )
            .returning();

          if (!job) break;
          this.launchJob(job);
        }
      } while (this.pumpAgain && this.active.size < this.maxConcurrent);
    } finally {
      this.pumping = false;
    }
  }

  private launchJob(job: typeof adminJob.$inferSelect): void {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.logSeq.set(job.id, 0);

    void this.executeJob(
      job.id,
      job.type,
      (job.payload as Record<string, unknown>) ?? {},
      controller.signal,
    )
      .finally(() => {
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
    signal: AbortSignal,
  ): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) {
      await db
        .update(adminJob)
        .set({
          status: "failed",
          error: `No handler registered for job type "${type}"`,
          finishedAt: new Date(),
        })
        .where(eq(adminJob.id, jobId));
      return;
    }

    const ctx: JobContext = {
      jobId,
      payload,
      signal,
      log: async (line, stream = "stdout") => {
        const seq = this.logSeq.get(jobId) ?? 0;
        this.logSeq.set(jobId, seq + 1);
        await db.insert(adminJobLog).values({ id: randomUUID(), jobId, seq, stream, line });
      },
      setProgress: async (progress) => {
        await db.update(adminJob).set({ progress }).where(eq(adminJob.id, jobId));
      },
      checkpoint: async (result, progress) => {
        await db
          .update(adminJob)
          .set({ result, ...(progress === undefined ? {} : { progress }) })
          .where(eq(adminJob.id, jobId));
      },
    };

    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await handler(ctx);
      if (signal.aborted) {
        await db
          .update(adminJob)
          .set({ status: "canceled", finishedAt: new Date() })
          .where(eq(adminJob.id, jobId));
      } else {
        await db
          .update(adminJob)
          .set({
            status: "success",
            result: (result ?? null) as Record<string, unknown> | null,
            finishedAt: new Date(),
            progress: 100,
          })
          .where(eq(adminJob.id, jobId));
      }
    } catch (err) {
      const isAbort = signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      await db
        .update(adminJob)
        .set(
          isAbort
            ? { status: "canceled", finishedAt: new Date() }
            : {
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
                finishedAt: new Date(),
              },
        )
        .where(eq(adminJob.id, jobId));
    }
  }
}

export const jobRunner = new AdminJobRunner();
