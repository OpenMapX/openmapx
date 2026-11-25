/**
 * The closed vocabularies of the API's `admin_job` table and data-manager's
 * `data_manager.job` and `data_manager.job_stage` tables. The database CHECKs
 * on those columns are generated from these lists.
 */

/** The lifecycle of a job in either table. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "cancel_pending",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The statuses of a job its runner still owns. */
export const ACTIVE_JOB_STATUSES = ["queued", "running", "cancel_pending"] as const;
export type ActiveJobStatus = (typeof ACTIVE_JOB_STATUSES)[number];

/** The statuses a job ends in. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * A data job's statuses add two to the shared ones. `partially_succeeded`
 * ends a run that published without part of its work: a transit sync with
 * feeds missing, or an Overture import whose link rebuild did not complete.
 * `interrupted` is never terminal: the execution's worker ended without a
 * recorded outcome and its publication is unknown, so the data plane stays
 * fenced until recovery settles it.
 */
export const DATA_JOB_STATUSES = [...JOB_STATUSES, "partially_succeeded", "interrupted"] as const;
export type DataJobStatus = (typeof DATA_JOB_STATUSES)[number];

/** The statuses a data job ends in. */
export const DATA_JOB_TERMINAL_STATUSES = [
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
] as const;
export type DataJobTerminalStatus = (typeof DATA_JOB_TERMINAL_STATUSES)[number];

/** How a recorded stage of a transit run ended. */
export const JOB_STAGE_STATUSES = [
  "succeeded",
  "partially_succeeded",
  "failed",
  "skipped",
] as const;
export type JobStageStatus = (typeof JOB_STAGE_STATUSES)[number];

/**
 * What started a data job: the API (for an administrator or the service
 * token), the operations agent, the host CLI, data-manager's own schedule or
 * its first start. A job the API started for an administrator also names that
 * account.
 */
export const DATA_JOB_TRIGGERS = ["api", "agent", "cli", "cron", "bootstrap"] as const;
export type DataJobTrigger = (typeof DATA_JOB_TRIGGERS)[number];

/**
 * The administrative job types, named `<area>.<object>.<verb>` (or
 * `<area>.<verb>`) with an imperative verb and a singular object.
 */
export const ADMIN_JOB_TYPES = [
  "artifact.export",
  "artifact.import",
  "artifact.validate",
  "backup.operation.run",
  "backup.prune",
  "compose.render",
  "compose.start",
  "configuration.apply",
  "configuration.migration.apply",
  "configuration.migration.preview",
  "credential.import",
  "data.operation.run",
  "extension.install",
  "extension.remove",
  "integration.binding.apply",
  "integration.reload",
  "platform.apply",
  "release.clear",
  "service.apply",
  "service.batch.run",
  "service.core.restart",
  "service.image.pull",
  "service.restart",
  "service.start",
  "service.stop",
  "standalone.install",
  "standalone.preview",
  "standalone.remove",
  "system.diagnostics.collect",
  "system.update",
] as const;
export type AdminJobType = (typeof ADMIN_JOB_TYPES)[number];

/** The job types that share the host's one maintenance writer slot. */
export const SYSTEM_MAINTENANCE_JOB_TYPES = [
  "system.update",
  "system.diagnostics.collect",
] as const satisfies readonly AdminJobType[];
