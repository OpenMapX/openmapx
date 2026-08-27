import { jobStages, jobs } from "@openmapx/db-schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { scrubDiagnosticValue, scrubSecrets } from "../../utils/scrub-secrets.js";
import type { JobLogger, StageResult, StageStatus } from "./types.js";

export interface CreateJobOptions {
  kind?: string;
  triggeredBy?: string | null;
  metadata?: Record<string, unknown>;
}

/** Insert a new `data_manager.jobs` row in `running` state and return its id. */
export async function createJobRow(opts: CreateJobOptions = {}): Promise<string> {
  const inserted = await db
    .insert(jobs)
    .values({
      kind: opts.kind ?? "transitous-sync",
      status: "running",
      triggeredBy: opts.triggeredBy ?? null,
      metadata: opts.metadata ?? null,
    })
    .returning({ id: jobs.id });
  const row = inserted[0];
  if (!row) throw new Error("Failed to create data_manager.jobs row");
  return row.id;
}

/** Mark the job as finished with the aggregated status. */
export async function finalizeJobRow(jobId: string, status: StageStatus): Promise<void> {
  await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, jobId));
}

/**
 * Build an `onStageComplete` hook bound to a specific job id. The hook is
 * intentionally permissive: failures to persist a stage result are logged
 * and swallowed so a transient DB outage does not collapse an otherwise
 * successful Transitous run.
 */
export function makePersistingOnStageComplete(
  jobId: string,
  logger: JobLogger,
): (result: StageResult) => Promise<void> {
  return async (result) => {
    try {
      const diagnostics = scrubDiagnosticValue({
        message: result.message ?? null,
        error: result.error ?? null,
        artifacts: result.artifacts ?? null,
      }) as {
        message: string | null;
        error: StageResult["error"] | null;
        artifacts: Record<string, unknown> | null;
      };
      await db.insert(jobStages).values({
        jobId,
        stage: result.stage,
        status: result.status,
        startedAt: new Date(result.startedAt),
        finishedAt: new Date(result.finishedAt),
        durationMs: result.durationMs,
        message: diagnostics.message,
        error: diagnostics.error,
        artifacts: diagnostics.artifacts,
      });
    } catch (err) {
      logger.warn(
        scrubSecrets(
          `transitous-pipeline: failed to persist stage result for ${result.stage}: ${(err as Error).message}`,
        ),
      );
    }
  };
}
