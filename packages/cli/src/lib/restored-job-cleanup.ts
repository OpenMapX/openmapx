/** Recorded on every job that a restore closes because its process no longer exists. */
export const RESTORED_JOB_FAILURE_REASON = "restored from backup";

/**
 * Closes the work a backup captured mid-flight. A restored row that still reads
 * queued or running would be adopted again by the job runner or the data manager
 * and replay host effects against a deployment that has moved on.
 *
 * A data-manager row counts as open when any of these holds: its status is
 * queued, running, cancel-pending or interrupted (an execution awaiting
 * recovery); its publication outcome is unknown, which keeps an execution
 * non-terminal whatever its status says; or a child (a cell of its execution
 * row that data-manager took up) or an agent operation has not settled.
 *
 * An open row becomes `failed` unless it already carries a final status. Its
 * unknown publication is recorded as not started, and its retained child and
 * agent operation attempts, its execution row and its worker completion are
 * dropped: they could only be settled with receipts from a host timeline that
 * the restore replaced, and an unsettled child lets the recovery pass pull a
 * closed execution back to interrupted/unknown. Data-manager's control prune
 * removes the files named by its key once it finished 72 hours ago and its
 * key expired, and the API deletes the row 90 days after it finished. A row
 * that is already settled, including its children, is left untouched.
 * Offline packages still being prepared are failed the same way; a finished
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
UPDATE data_manager.job
SET status = CASE WHEN status IN ('succeeded', 'partially_succeeded', 'failed', 'cancelled') THEN status ELSE 'failed' END,
    finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
    metadata = CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
      || jsonb_build_object('failureReason', ${reason}::text),
    execution_state = CASE
      WHEN execution_state->>'publication' = 'unknown'
        THEN jsonb_set(execution_state, '{publication}', '"not_started"'::jsonb)
      ELSE execution_state
    END,
    execution_agent_operations = '[]'::jsonb,
    execution_admission = NULL,
    execution_progress = NULL,
    execution_completion = NULL,
    released_at = NULL
WHERE status IN ('queued', 'running', 'cancel_pending', 'interrupted')
   OR execution_state->>'publication' = 'unknown'
   OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(COALESCE(execution_progress->'children', '[]'::jsonb)) AS child
     WHERE (jsonb_typeof(child->'owner') = 'object'
         OR jsonb_typeof(child->'binding') = 'object'
         OR jsonb_typeof(child->'delegation') = 'object')
       AND child #>> '{owner,observed,state}' IS DISTINCT FROM 'terminal'
   )
   OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(execution_agent_operations) AS operation
     WHERE operation->>'state' = 'attempted'
   );
UPDATE data_manager.offline_package_job
SET status = 'failed',
    error_message = ${reason},
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'preparing';
COMMIT;
`;
}
