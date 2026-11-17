/** A queued maintenance request names its actor, idempotency key and body digest. */
import { z } from "zod";
import { JobObservationPending } from "./admin-job-failure";
import type { JobContext } from "./job-runner";
export const MAINTENANCE_JOB_TYPES = [
  "release.clear",
  "service.images.pull",
  "backup.prune",
  "compose.render",
  "artifact.validate",
  "artifact.import",
  "artifact.export",
] as const;
const maintenanceRequestSchema = z.object({
  actorId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Routing for a reclaimed job of one of these types: its handler runs again. */
export function retainedMaintenanceJob(job: { type: string; payload: unknown }): boolean {
  const payload = job.payload as Record<string, unknown> | null;
  return (
    (MAINTENANCE_JOB_TYPES as readonly string[]).includes(job.type) &&
    maintenanceRequestSchema.safeParse(payload?._maintenanceRequest).success
  );
}
export function assertRetainedMaintenanceJob(ctx: JobContext): void {
  if (!ctx.jobType || !retainedMaintenanceJob({ type: ctx.jobType, payload: ctx.payload }))
    throw new JobObservationPending("invalid_identity");
}
