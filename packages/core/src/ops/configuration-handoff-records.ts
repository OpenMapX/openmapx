/** Fixed handoff data. A matching DTO never supplies target authority. */
import { z } from "zod";
import { COMPONENT_ID_PATTERN } from "../component-id";
import { PROTECTED_CONFIGURATION_SERVICE_IDS } from "../services/core-service-ids";
import { strictlyAscending } from "../utils/strictlyAscending";

const id = z.string().regex(COMPONENT_ID_PATTERN);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const protectedConfigurationServiceIdSchema = z.enum(PROTECTED_CONFIGURATION_SERVICE_IDS);
export type ProtectedConfigurationServiceId = z.infer<typeof protectedConfigurationServiceIdSchema>;
/** Explicit reconciliation of already-saved protected settings, never a new image selection. */
export const protectedConfigurationReconcileIdsSchema = z
  .array(protectedConfigurationServiceIdSchema)
  .min(1)
  .max(PROTECTED_CONFIGURATION_SERVICE_IDS.length)
  .refine(strictlyAscending);
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
    serviceIds: z.array(id).min(1).max(64).refine(strictlyAscending),
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
/** What the configuration helper reports while it replaces protected services.
 * Only the helper writes it; the agent reads it once the helper container exited. */
export const handoffProgressSchema = z
  .strictObject({
    version: z.literal(1),
    maintenanceId: z.uuid(),
    handoffId: z.uuid(),
    phase: z.enum(["applying", "verifying", "applied", "cancelled", "failed"]),
    targets: z
      .array(
        z.strictObject({
          serviceId: id,
          phase: z.enum(["pending", "recreate_attempted", "verified"]),
          oldContainerId: z.string().regex(/^[a-f0-9]{64}$/),
          newContainerId: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(64),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (value) =>
      new Set(value.targets.map((target) => target.serviceId)).size === value.targets.length,
  );
export type HandoffProgress = z.infer<typeof handoffProgressSchema>;
