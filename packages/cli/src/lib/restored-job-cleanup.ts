/** Recorded on every job that a restore closes because its process no longer exists. */
export const RESTORED_JOB_FAILURE_REASON = "restored from backup";

/**
 * Closes the work a backup captured mid-flight. A restored row that still reads
 * queued or running would be adopted again by the job runner or the data manager
 * and replay host effects against a deployment that has moved on.
 *
 * The data-manager statuses mirror what the activity view treats as active:
 * queued, running and cancel-pending executions, plus a current-version
 * execution that was interrupted before its publication outcome was known.
 * Offline packages still being prepared are closed the same way; a finished
 * package stays available.
 */
export function failRestoredJobsSql(): string {
  const reason = `'${RESTORED_JOB_FAILURE_REASON}'`;
  return `BEGIN;
UPDATE admin_job
SET status = 'failed',
    error = ${reason},
    finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
WHERE status IN ('queued', 'running', 'cancel_pending');
UPDATE data_manager.jobs
SET status = 'error',
    finished_at = CURRENT_TIMESTAMP,
    metadata = CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
      || jsonb_build_object('failureReason', ${reason}::text)
WHERE status IN ('queued', 'running', 'cancel_pending')
   OR (execution_version = 2
       AND status = 'interrupted'
       AND finished_at IS NULL
       AND execution_state->>'publication' = 'unknown');
UPDATE data_manager.offline_package_jobs
SET status = 'failed',
    error_message = ${reason},
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'preparing';
COMMIT;
`;
}
