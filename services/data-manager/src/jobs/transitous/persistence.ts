import { makePersistingOnStageComplete as makeSharedPersistingOnStageComplete } from "../persistence.js";
import type { JobLogger, StageResult } from "./types.js";

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
