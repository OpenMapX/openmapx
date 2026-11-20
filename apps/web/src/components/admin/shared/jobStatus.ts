import type { AdminTranslator } from "@/lib/admin/adminTranslator";

export type JobStatusColor = "default" | "primary" | "success" | "error" | "warning" | "info";

const JOB_STATUS_COLOR: Record<string, JobStatusColor> = {
  queued: "default",
  running: "primary",
  success: "success",
  ok: "success",
  failed: "error",
  error: "error",
  canceled: "warning",
  partial: "warning",
  stale: "warning",
  // A data job a data-manager restart ended, or one awaiting recovery.
  interrupted: "warning",
  skipped: "default",
};

export function jobStatusColor(status: string): JobStatusColor {
  return JOB_STATUS_COLOR[status] ?? "default";
}

/** The catalogue key describing each job or stage status that has a description. */
const JOB_STATUS_DESCRIPTION_KEY: Record<string, string> = {
  queued: "jobQueued",
  running: "jobRunning",
  success: "jobSucceeded",
  ok: "jobSucceeded",
  failed: "jobFailed",
  error: "jobStageFailed",
  canceled: "jobCanceled",
  partial: "jobPartial",
  interrupted: "jobInterrupted",
  skipped: "jobSkipped",
};

export function jobStatusDescription(status: string, t: AdminTranslator): string | null {
  const key = JOB_STATUS_DESCRIPTION_KEY[status];
  return key ? t(key) : null;
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
