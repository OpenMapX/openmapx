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
    return (
      all.length <= 256 &&
      new Set(all).size === all.length &&
      (x.outcome === "success"
        ? x.completedServiceIds.length > 0 &&
          x.failedServiceIds.length === 0 &&
          x.skippedServiceIds.length === 0
        : x.outcome === "partial"
          ? x.completedServiceIds.length > 0
          : x.completedServiceIds.length === 0)
    );
  });
export type ServiceBatchResult = z.infer<typeof serviceBatchResultSchema>;

export const SERVICE_BUILD_ORDER = ["osrm", "otp", "motis", "pelias", "tileserver"] as const;
export function compareServiceBuildOrder(a: string, b: string): number {
  const rank = (id: string) => {
    const index = SERVICE_BUILD_ORDER.indexOf(id as (typeof SERVICE_BUILD_ORDER)[number]);
    return index < 0 ? Infinity : index;
  };
  return rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b);
}

/** An attempted unknown item is omitted, never mislabeled failed or skipped. */
export function createServiceBatchResult(
  serviceIds: readonly string[],
  completedServiceIds: readonly string[],
  failedServiceIds: readonly string[],
  skippedServiceIds: readonly string[],
): ServiceBatchResult {
  const admitted = new Set(ids.parse(serviceIds));
  const all = [...completedServiceIds, ...failedServiceIds, ...skippedServiceIds];
  if (all.some((id) => !admitted.has(id))) throw Error("Unadmitted service batch target");
  return serviceBatchResultSchema.parse({
    outcome:
      completedServiceIds.length === 0
        ? "failed"
        : completedServiceIds.length === admitted.size
          ? "success"
          : "partial",
    completedServiceIds,
    failedServiceIds,
    skippedServiceIds,
  });
}
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
export const serviceActionsSchema = z.strictObject({
  start: serviceActionDecisionSchema,
  stop: serviceActionDecisionSchema,
  restart: serviceActionDecisionSchema,
  update: serviceActionDecisionSchema,
  build: serviceActionDecisionSchema,
  logs: serviceActionDecisionSchema,
  pull: serviceActionDecisionSchema,
  apply: serviceActionDecisionSchema,
});
