import {
  createJobRow as createSharedJobRow,
  finalizeJobRow as finalizeSharedJobRow,
  makePersistingOnStageComplete as makeSharedPersistingOnStageComplete,
} from "../persistence.js";
import type { JobLogger, StageResult, StageStatus } from "./types.js";

export interface CreateJobOptions {
  kind?: string;
  triggeredBy?: string | null;
  metadata?: Record<string, unknown>;
}

/** Insert a new `data_manager.jobs` row in `running` state and return its id. */
export async function createJobRow(opts: CreateJobOptions = {}): Promise<string> {
  return createSharedJobRow({
    kind: opts.kind ?? "transitous-sync",
    triggeredBy: opts.triggeredBy,
    metadata: opts.metadata,
  });
}

/** Mark the job as finished with the aggregated status. */
export async function finalizeJobRow(jobId: string, status: StageStatus): Promise<void> {
  await finalizeSharedJobRow(jobId, status);
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
  return makeSharedPersistingOnStageComplete(jobId, logger, "transitous-pipeline");
}
