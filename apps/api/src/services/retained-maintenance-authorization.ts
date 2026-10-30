/** Existing API token authenticates the exact retained row, request and actor. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, readOpsTokenFile } from "@openmapx/core/ops";
import { JobObservationPending } from "./admin-job-failure";
import type { JobContext } from "./job-runner";
export const MAINTENANCE_JOB_TYPES = [
  "release.clear",
  "service.images.pull",
  "backup.prune",
  "compose.render",
  "artifact.validate",
] as const;
export function maintenanceJobAuthorization(
  token: string,
  body: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
    actorId: string;
    key: string;
  },
): string {
  return createHmac("sha256", token)
    .update("openmapx-maintenance-job-authorization-v1\0")
    .update(canonicalJson(body))
    .digest("hex");
}
/** Routing only. The handler still verifies the MAC before any next phase. */
export function retainedMaintenanceJob(job: { type: string; payload: unknown }): boolean {
  const payload = job.payload as Record<string, unknown> | null,
    metadata = payload?._maintenanceRequest as Record<string, unknown> | undefined;
  return (
    (MAINTENANCE_JOB_TYPES as readonly string[]).includes(job.type) &&
    typeof metadata?.authorization === "string" &&
    /^[a-f0-9]{64}$/.test(metadata.authorization)
  );
}
export async function assertRetainedMaintenanceJob(ctx: JobContext): Promise<void> {
  if (!ctx.jobType || !retainedMaintenanceJob({ type: ctx.jobType, payload: ctx.payload }))
    throw new JobObservationPending("invalid_identity");
  const { _maintenanceRequest, ...payload } = ctx.payload,
    record = _maintenanceRequest as Record<string, unknown>;
  if (
    typeof record.actorId !== "string" ||
    typeof record.key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(record.key)
  )
    throw new JobObservationPending("invalid_identity");
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
    expected = maintenanceJobAuthorization(token, {
      jobId: ctx.jobId,
      type: ctx.jobType,
      payload,
      actorId: record.actorId,
      key: record.key,
    });
  if (
    !timingSafeEqual(Buffer.from(String(record.authorization), "hex"), Buffer.from(expected, "hex"))
  )
    throw new JobObservationPending("invalid_identity");
}
