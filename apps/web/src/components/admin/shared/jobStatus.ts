export type JobStatusColor = "default" | "primary" | "success" | "error" | "warning" | "info";

export const JOB_STATUS_COLOR: Record<string, JobStatusColor> = {
  queued: "default",
  running: "primary",
  success: "success",
  failed: "error",
  error: "error",
  canceled: "warning",
  partial: "warning",
  stale: "warning",
  // A job orphaned in `running` by a data-manager restart, reconciled on the
  // next boot (services/data-manager reconcileOrphanedJobs).
  interrupted: "warning",
};

export function jobStatusColor(status: string): JobStatusColor {
  return JOB_STATUS_COLOR[status] ?? "default";
}

/**
 * Coerce a job/stage `error` value into a displayable string.
 *
 * The data-manager persists stage errors into a `jsonb` column as a structured
 * `{ message, stack }` object (see services/data-manager stage runners), so the
 * value reaching the admin UI is NOT a plain string. Rendering an object as a
 * React child throws "Objects are not valid as a React child" and crashes the
 * whole page, so every render site must run the value through here first.
 *
 * Prefers the concise `message`, falls back to `stack`, then to JSON. Returns
 * null for empty values so callers can skip rendering entirely.
 */
export function formatStageError(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed === "" ? null : error;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim() !== "") return record.message;
    if (typeof record.stack === "string" && record.stack.trim() !== "") return record.stack;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
