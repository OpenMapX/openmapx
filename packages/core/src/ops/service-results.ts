import { z } from "zod";

export type CoordinatorMode = "ensure-running" | "require-running";
const count = z.number().int().nonnegative().safe();
export const hardlinkApplySummarySchema = z.strictObject({
  applied: z.boolean(),
  linked: count,
  skipped: count,
  pruned: count,
  entries: count,
  via: z.enum(["data-manager", "local", "none"]).optional(),
});
export type HardlinkApplySummary = z.infer<typeof hardlinkApplySummarySchema>;
export type ServicePreparationResult = {
  revisionId: string;
  hardlinks: HardlinkApplySummary;
  coordinatorMode: CoordinatorMode;
};
const serviceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ids = z
  .array(serviceId)
  .max(256)
  .refine((x) => new Set(x).size === x.length);
export const serviceBatchResultSchema = z
  .strictObject({
    outcome: z.enum(["success", "partial", "failed"]),
    completedServiceIds: ids,
    failedServiceIds: ids,
    skippedServiceIds: ids,
  })
  .refine((x) => {
    const all = [...x.completedServiceIds, ...x.failedServiceIds, ...x.skippedServiceIds];
    return all.length <= 256 && new Set(all).size === all.length;
  });
export type ServiceBatchResult = z.infer<typeof serviceBatchResultSchema>;
const revision = z
  .string()
  .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
  .nullable();
export const serviceLifecycleFailureEvidenceSchema = z.strictObject({
  expectedRevisionId: revision,
  seedRevisionId: revision,
  finalRevisionId: revision,
  phase: z.enum([
    "prepared",
    "pins_validated",
    "pulled",
    "generation_committed",
    "hardlinks_applied",
    "recreated",
    "complete",
    "failed",
    "unknown",
  ]),
  commit: z.enum(["not_committed", "seed_committed", "final_committed", "unknown"]),
  followUp: z.enum(["not_started", "complete", "failed", "unknown"]),
  failure: z
    .strictObject({
      reason: z.enum([
        "pins",
        "pull",
        "revision_conflict",
        "hardlinks",
        "recreate",
        "deadline",
        "canceled",
        "containment",
        "receipt_io",
      ]),
      failedServiceIds: ids,
    })
    .optional(),
});
export type ServiceLifecycleFailureEvidence = z.infer<typeof serviceLifecycleFailureEvidenceSchema>;

export const SERVICE_ACTIONS = [
  "start",
  "stop",
  "restart",
  "update",
  "build",
  "logs",
  "pull",
  "apply",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export const serviceActionDecisionSchema = z
  .strictObject({
    available: z.boolean(),
    execution: z.enum(["direct", "workflow", "host"]),
    reason: z
      .enum([
        "disabled",
        "not_owned",
        "not_running",
        "control_plane",
        "host_only",
        "unavailable",
        "not_buildable",
      ])
      .nullable(),
    workflow: z
      .enum(["core-restart", "system-update", "coordinator-apply", "coordinator-update"])
      .nullable(),
  })
  .refine((decision) =>
    decision.available
      ? decision.reason === null &&
        (decision.execution === "direct"
          ? decision.workflow === null
          : decision.execution === "workflow" && decision.workflow !== null)
      : decision.reason !== null &&
        (decision.execution !== "host" || decision.reason === "host_only"),
  );
export type ServiceActionDecision = z.infer<typeof serviceActionDecisionSchema>;
export const serviceActionsSchema = z.record(z.enum(SERVICE_ACTIONS), serviceActionDecisionSchema);
