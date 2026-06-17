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
};

export function jobStatusColor(status: string): JobStatusColor {
  return JOB_STATUS_COLOR[status] ?? "default";
}
