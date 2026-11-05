/** Fixed handoff data. A matching DTO never supplies target authority. */
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const protectedConfigurationServiceIdSchema = z.enum([
  "postgis",
  "redis",
  "app-web",
  "app-api",
  "traefik",
  "ops-agent",
]);
export type ProtectedConfigurationServiceId = z.infer<typeof protectedConfigurationServiceIdSchema>;
/** Explicit reconciliation of already-saved protected settings, never a new image selection. */
export const protectedConfigurationReconcileIdsSchema = z
  .array(protectedConfigurationServiceIdSchema)
  .min(1)
  .max(6)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
export const configurationHandoffModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("configuration") }),
  z.strictObject({
    kind: z.literal("release"),
    releaseId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    manifestDigest: digest,
  }),
]);
export const configurationHandoffIntentSchema = z
  .strictObject({
    handoffId: z.uuid(),
    previewFingerprint: digest,
    serviceIds: z
      .array(id)
      .min(1)
      .max(64)
      .refine((ids) => ids.every((v, i) => i === 0 || ids[i - 1]! < v)),
    expectedImageIdentities: z.record(id, z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    mode: configurationHandoffModeSchema,
  })
  .superRefine((value, ctx) => {
    if (
      JSON.stringify(value).length > 24576 ||
      JSON.stringify(Object.keys(value.expectedImageIdentities).sort()) !==
        JSON.stringify(value.serviceIds) ||
      (value.mode.kind === "configuration" &&
        value.serviceIds.some((id) => !protectedConfigurationServiceIdSchema.safeParse(id).success))
    )
      ctx.addIssue({ code: "custom", message: "Invalid frozen handoff target/image set" });
  });
export type ConfigurationHandoffIntent = z.infer<typeof configurationHandoffIntentSchema>;
export const configurationHandoffPrepareOperationSchema =
  configurationHandoffIntentSchema.safeExtend({
    kind: z.literal("configurationHandoff.prepare"),
    maintenanceId: z.uuid(),
    candidateId: z.uuid(),
    planDigest: digest,
    expectedCurrentRevisionId: revision,
  });
export const configurationHandoffInspectOperationSchema = z.strictObject({
  kind: z.literal("configurationHandoff.inspect"),
  handoffId: z.uuid(),
});
export const configurationHandoffPreparedSchema = z.strictObject({
  handoffId: z.uuid(),
  phase: z.literal("prepared"),
});
export const configurationHandoffInspectionSchema = z
  .strictObject({
    handoffId: z.uuid(),
    phase: z.enum([
      "prepared",
      "draining",
      "applying",
      "verifying",
      "applied",
      "rolled_back",
      "failed",
      "recovery_required",
    ]),
    expectedRevisionId: revision,
    appliedRevisionId: revision.nullable(),
    completedServiceIds: z.array(id).max(64),
    failedServiceIds: z.array(id).max(64),
    recoveryCodes: z
      .array(
        z.enum([
          "helper_unavailable",
          "launch_unknown",
          "source_changed",
          "deadline_expired",
          "cancel_pending",
          "container_unknown",
          "readiness_failed",
          "restore_failed",
          "receipt_pending",
        ]),
      )
      .max(16),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.completedServiceIds).size !== value.completedServiceIds.length ||
      new Set(value.failedServiceIds).size !== value.failedServiceIds.length ||
      value.failedServiceIds.some((id) => value.completedServiceIds.includes(id)) ||
      (value.phase === "applied" &&
        (value.appliedRevisionId !== value.expectedRevisionId || value.failedServiceIds.length > 0))
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent handoff observation" });
  });
